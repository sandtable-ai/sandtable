import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { lintDomain } from "../grade/lint.ts";
import { validateDomain } from "../spec/load.ts";
import { PersonaSpec, TaskSpec, type Domain, type Persona, type Task } from "../spec/schema.ts";
import type { UsageByModel } from "../run/usage.ts";
import { createClient, recordDraftUsage, requestBase, type ClaudeOptions } from "../sim/claude.ts";
import { copiedValueNotes, type Place } from "./copied.ts";
import { ConditionSpec, describeTools, whereOf } from "./sop.ts";
import { equal } from "../world/match.ts";

export interface TranscriptDraft {
  tasks: Task[];
  personas: Persona[];
  /** New seed rows the tasks rely on, per table. */
  rows: Record<string, Record<string, unknown>[]>;
  warnings: string[];
  /** Review notes per task id, such as a reused row that contradicts the transcript; `init` writes them as `# TODO(review):` comments above the task. */
  notes: Record<string, string[]>;
  redactions: number;
  /** Personal values from the transcripts that the drafted tasks hold, each a review note on its task. */
  copied: number;
  /** Tokens the drafting calls used, one per transcript, per model, for `init` to print with an estimated cost. */
  usage: UsageByModel;
  /**
   * The transcripts whose drafting call failed, in order, with the error. A failure that concerns only that chat (an
   * outage, throttling or an oversized request that outlasted the retries) lets the others be drafted, so one failed
   * call doesn't throw away the chats already paid for. Any other failure stops drafting: see `notSent`.
   */
  failed: { file: string; error: string }[];
  /**
   * The transcripts never sent, in order: after the last entry of `failed` hit an error every later call would hit too,
   * such as missing credentials, a denied or unknown model, or no connection. Empty when drafting went to the end.
   */
  notSent: string[];
}

/**
 * Whether a failed drafting call says nothing about the next transcript's: a status the API returns for one request,
 * such as a request too large (400, 413), throttling (429) or an outage (5xx). Any other error, such as 401, 403 or
 * 404, or one with no HTTP status (missing credentials, no SDK package, no connection), will hit every call.
 */
export function onlyThisTranscript(err: unknown): boolean {
  const status = typeof err === "object" && err !== null ? (err as { status?: unknown }).status : undefined;
  return typeof status === "number" && (status === 400 || status === 413 || status === 429 || status >= 500);
}

/**
 * Deterministic PII scrub, run before any transcript leaves the machine. Catches emails,
 * phone numbers (10+ digits) and card-like numbers. Names are left to the model, which is
 * told to replace them; short identifiers (order or MC numbers) are kept on purpose.
 */
export function scrubPii(text: string): { text: string; redactions: number } {
  let redactions = 0;
  const sub = (re: RegExp, label: string) => (s: string) =>
    s.replace(re, () => {
      redactions++;
      return label;
    });
  const steps = [
    sub(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]"),
    sub(/\b(?:\d[ -]?){13,19}\b/g, "[card]"),
    sub(/(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "[phone]"),
  ];
  const out = steps.reduce((s, step) => step(s), text);
  return { text: out, redactions };
}

const Scalar = z.union([z.string(), z.number(), z.boolean()]);

function outputSchema(tools: string[], tables: string[]) {
  const Tool = z.enum(tools as [string, ...string[]]);
  const Table = z.enum(tables as [string, ...string[]]);
  return z.object({
    id: z.string().describe("kebab-case task id describing the scenario, e.g. negotiate-above-posted-rate"),
    description: z.string().describe("one sentence: the situation and what the agent should do"),
    quote: z.string().describe("the most telling excerpt of the transcript, copied verbatim"),
    tags: z.array(z.string()).describe("short tags such as happy-path, negotiation, refusal, handoff, vetting"),
    persona_id: z.string().describe("an existing persona id, or the id of new_persona"),
    new_persona: z.object({ id: z.string(), description: z.string() }).nullable(),
    instructions: z
      .string()
      .describe("hidden instructions for the simulated caller, in second person: who they are, their goal, limits they hold to, private facts (identifiers) they reveal when asked, when to end the call. Never include the business's internal data."),
    script: z.array(z.string()).describe("the caller's turns in order, adapted to the fictional entities, for deterministic replays"),
    new_rows: z
      .array(z.object({ table: Table, fields: z.array(z.object({ name: z.string(), value: Scalar })) }))
      .describe("fictional seed rows this scenario needs that the world does not have yet (include the key field)"),
    existing_rows: z
      .array(
        z.object({
          table: Table,
          key: z.string().describe("the reused row's key value"),
          facts: z
            .array(z.object({ name: z.string(), value: Scalar }))
            .describe("each field of this row that the transcript states a value for, with the value the transcript states (in its fictional form), even where it differs from the row"),
        }),
      )
      .describe("existing rows from the Tables list that this scenario uses as they are, such as the customer, account or order the transcript is about"),
    expect_state: z
      .array(z.object({ table: Table, conditions: z.array(ConditionSpec), count: z.number().int().nullable() }))
      .describe("end state if the agent follows the policy: rows matching the conditions, exactly `count` of them (null = at least one)"),
    reference: z
      .array(z.object({ tool: Tool, args: z.array(z.object({ name: z.string(), value: Scalar })) }))
      .describe("the tool calls a correct agent following the policy makes in this scenario, in order, with their arguments: only calls that succeed (leave out one the API would reject)"),
    expect_called: z.array(Tool).describe("tools that must succeed at least once"),
    expect_not_called: z.array(Tool).describe("tools that must never be called"),
  });
}

type Proposal = z.infer<ReturnType<typeof outputSchema>>;

const SYSTEM = `You turn one real customer call or chat transcript into a test scenario for an AI agent that will take over this conversation type.

You get the company's policy, the agent's tools, the world's tables with their current rows, and existing personas. Produce:
- a hidden-goal instruction for a simulated caller who behaves like the real one (same goal, same pushback, same limits), written in second person;
- the caller's turns as a script;
- the end state the world must be in **if the agent follows the policy**. That is not necessarily what the human rep did: when the rep broke the policy, the expectation follows the policy;
- the tools that must and must not be called, only when the policy makes that clear;
- as reference, the tool calls a correct agent makes when it follows the policy, in order and with their arguments, using the identifiers of the rows you reuse or add. sandtable replays them against the world to prove the scenario can be passed, so list only calls that succeed: leave out a call the API would reject, such as a lookup of an identifier that doesn't exist. A refusal may end with lookups only.

Make everything fictional. Replace people's names, company names and identifiers with fictional ones. Use only the listed tables, fields and tools. A param with values in parentheses takes exactly one of them, as written: map the transcript's wording to it ("By Mail" is by_mail). Prefer exact conditions on keys (e.g. which load was booked by which carrier) and ranges for negotiated numbers; use in for a field that may end as any of several values, and exists for a field that must be set or left unset.

Keep the transcript's facts. Reuse an existing row only when every fact the transcript states about it matches the row: a membership level, status, date, amount or item that differs means it is not the same record, even when the name matches (the same customer may have called before, with different facts then). Otherwise propose new_rows with new identifiers and every field the scenario needs, including the table key, consistent with the conditions you expect. Never change what the transcript says to fit an existing row, and never invent a conflict the transcript does not have. List each existing row you reuse in existing_rows, with the facts the transcript states about it.`;

/** The drafting system prompt, for `init --dry-run`'s size estimate. */
export const TRANSCRIPTS_SYSTEM_PROMPT = SYSTEM;

function describe(domain: Domain): string {
  const tools = describeTools(domain);
  const tables = Object.entries(domain.world.tables)
    .map(([name, t]) => `- ${name} (key ${t.key}), ${t.rows.length} row(s):\n${t.rows.slice(0, 20).map((r) => `    ${JSON.stringify(r)}`).join("\n")}`)
    .join("\n");
  const personas = domain.personas.map((p) => `- ${p.id}: ${p.description}`).join("\n") || "(none)";
  return `<policy>\n${domain.policy.trim()}\n</policy>\n\nTools:\n${tools}\n\nTables:\n${tables}\n\nPersonas:\n${personas}`;
}

/** Two values that say the same thing: equal as sandtable compares them, or the same text up to case and surrounding spaces ("Gold" and "gold"). */
function sameFact(a: unknown, b: unknown): boolean {
  if (equal(a, b)) return true;
  return typeof a !== "object" && typeof b !== "object" && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/**
 * Where a drafted task's reused rows contradict its transcript: for each row it lists in `existing_rows`, the
 * fields whose value the transcript states differently from the row, or that the row doesn't exist. One line
 * per row, for a review note. Fields the row doesn't have are left to validation.
 */
export function reusedRowConflicts(domain: Domain, uses: Proposal["existing_rows"]): string[] {
  const out: string[] = [];
  for (const use of uses) {
    const table = domain.world.tables[use.table];
    if (!table) continue;
    const row = table.rows.find((r) => equal(r[table.key], use.key));
    if (!row) {
      out.push(`lists ${use.table} ${use.key} as an existing row, but there is none`);
      continue;
    }
    const differs = use.facts
      .filter((f) => Object.hasOwn(row, f.name) && !sameFact(row[f.name], f.value))
      .map((f) => `${f.name} ${JSON.stringify(f.value)} where the row has ${JSON.stringify(row[f.name])}`);
    if (differs.length) out.push(`reuses ${use.table} ${use.key}, but the transcript states ${differs.join(", and ")}`);
  }
  return out;
}

/** An enum value as the transcript might spell it: lowercase, with spaces and dashes as `_` ("By Mail" → by_mail). */
const enumForm = (v: unknown) => String(v).trim().toLowerCase().replace(/[\s-]+/g, "_");

/**
 * Fix the drafted reference arguments that miss a param's allowed values only in spelling: when the value, in
 * enumForm, matches exactly one allowed value, use that value. Returns one line per change, for a warning. A value
 * that matches none, or several, is left as drafted, so the draft-time lint reports it and the task gets a review note.
 */
export function normalizeEnumArgs(domain: Domain, task: Task): string[] {
  const changes: string[] = [];
  task.reference?.forEach((call, i) => {
    const tool = domain.tools.find((t) => t.name === call.tool);
    if (!tool) return;
    for (const [name, value] of Object.entries(call.args)) {
      const param = Object.hasOwn(tool.params, name) ? tool.params[name] : undefined;
      if (!param?.enum || param.enum.some((e) => equal(e, value))) continue;
      const matches = param.enum.filter((e) => enumForm(e) === enumForm(value));
      if (matches.length !== 1) continue;
      call.args[name] = matches[0];
      changes.push(`reference[${i}] ${call.tool} ${name} ${JSON.stringify(value)} → ${String(matches[0])}`);
    }
  });
  return changes;
}

/** The parts of a drafted task that can hold a value from its chat, each with where it is. */
function draftedPlaces(conv: { task: Task; persona?: Persona; rows: Record<string, Record<string, unknown>[]> }): Place[] {
  const { task } = conv;
  const places: Place[] = [
    { where: "the description", text: task.description ?? "" },
    { where: "the source quote", text: task.source?.quote ?? "" },
    { where: "the caller's instructions", text: task.user.instructions },
    { where: "the caller's script", text: (task.user.script ?? []).join("\n") },
    { where: "the reference calls", text: JSON.stringify(task.reference ?? []) },
    { where: "the expectations", text: JSON.stringify(task.expect) },
  ];
  for (const [table, rows] of Object.entries(conv.rows)) {
    for (const row of rows) places.push({ where: `a new ${table} row`, text: JSON.stringify(row) });
  }
  if (conv.persona) places.push({ where: `persona ${conv.persona.id}`, text: conv.persona.description });
  return places;
}

export function proposalToTask(p: Proposal, file: string): { task: Task; persona?: Persona; rows: Record<string, Record<string, unknown>[]> } | string {
  // Conditions on the same field are combined, so a range keeps both bounds.
  const state = p.expect_state.map((s) => ({ s, where: whereOf(s.conditions) }));
  const bad = state.find((x) => typeof x.where === "string");
  if (bad) return `expect_state on ${bad.s.table}: ${String(bad.where)}`;
  const task = TaskSpec.safeParse({
    id: p.id,
    description: p.description,
    persona: p.persona_id,
    tags: p.tags,
    review: "pending",
    source: { file, quote: p.quote },
    user: { instructions: p.instructions, ...(p.script.length ? { script: p.script } : {}) },
    ...(p.reference?.length ? { reference: p.reference.map((c) => ({ tool: c.tool, args: Object.fromEntries(c.args.map((x) => [x.name, x.value])) })) } : {}),
    expect: {
      state: state.map(({ s, where }) => ({ table: s.table, where, ...(s.count === null ? {} : { count: s.count }) })),
      called: p.expect_called,
      not_called: p.expect_not_called,
    },
  });
  if (!task.success) return task.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  if (!p.expect_state.length && !p.expect_called.length) return "no state or called expectations: nothing would be graded";
  const persona = p.new_persona ? PersonaSpec.safeParse(p.new_persona) : undefined;
  if (persona && !persona.success) return "invalid new_persona";
  const rows: Record<string, Record<string, unknown>[]> = {};
  for (const r of p.new_rows) (rows[r.table] ??= []).push(Object.fromEntries(r.fields.map((f) => [f.name, f.value])));
  return { task: task.data, ...(persona?.success ? { persona: persona.data } : {}), rows };
}

/**
 * Draft one task per transcript. Transcripts are PII-scrubbed locally first. Each proposal
 * must survive schema and cross-reference validation against the domain plus the rows it
 * adds; survivors are `review: pending` with the transcript as their source.
 */
export async function draftTasksFromTranscripts(input: {
  domain: Domain;
  transcripts: { file: string; text: string }[];
  claude?: ClaudeOptions;
}): Promise<TranscriptDraft> {
  const client = await createClient(input.claude ?? {});
  const base = requestBase(input.claude ?? {}, "high");
  const out: TranscriptDraft = { tasks: [], personas: [], rows: {}, warnings: [], notes: {}, redactions: 0, copied: 0, usage: {}, failed: [], notSent: [] };
  let domain = input.domain;
  // What the domain held before drafting: a value it already has, such as a seeded customer's name, isn't copied from a chat.
  const known = JSON.stringify({ world: input.domain.world, policy: input.domain.policy, tools: input.domain.tools, personas: input.domain.personas });

  for (const [i, t] of input.transcripts.entries()) {
    const scrubbed = scrubPii(t.text);
    out.redactions += scrubbed.redactions;
    const schema = outputSchema(domain.tools.map((x) => x.name), Object.keys(domain.world.tables));
    let response: Awaited<ReturnType<typeof client.beta.messages.parse>>;
    try {
      response = await client.beta.messages.parse({
        ...base,
        output_config: { ...base.output_config, format: betaZodOutputFormat(schema) },
        system: SYSTEM,
        messages: [{ role: "user", content: `${describe(domain)}\n\n<transcript file="${t.file}">\n${scrubbed.text}\n</transcript>` }],
      });
    } catch (err) {
      out.failed.push({ file: t.file, error: err instanceof Error ? err.message : String(err) });
      // An error about this chat alone lets the next one go: its call may well succeed. Any other would fail every
      // remaining chat the same way, after its retries, so stop and keep the chats drafted so far.
      if (onlyThisTranscript(err)) continue;
      out.notSent = input.transcripts.slice(i + 1).map((x) => x.file);
      break;
    }
    recordDraftUsage(out.usage, input.claude ?? {}, base.model, response);
    if (response.stop_reason === "refusal" || !response.parsed_output) {
      out.warnings.push(`${t.file}: no usable proposal`);
      continue;
    }
    const conv = proposalToTask(response.parsed_output, t.file);
    if (typeof conv === "string") {
      out.warnings.push(`${t.file}: dropped: ${conv}`);
      continue;
    }

    // A reference argument spelled as the transcript says it ("By Mail") gets the allowed value it plainly means.
    for (const c of normalizeEnumArgs(domain, conv.task)) out.warnings.push(`${t.file}: ${conv.task.id}: ${c}`);

    // Validate against the domain as it would be after adding this task's rows and persona.
    const candidate: Domain = structuredClone(domain);
    let rowProblem: string | undefined;
    for (const [table, rows] of Object.entries(conv.rows)) {
      const spec = candidate.world.tables[table]!;
      for (const row of rows) {
        const key = row[spec.key];
        if (key === undefined) rowProblem = `new ${table} row lacks key field ${spec.key}`;
        else if (spec.rows.some((r) => String(r[spec.key]) === String(key))) rowProblem = `new ${table} row ${String(key)} collides with an existing row`;
        else spec.rows.push(row);
      }
    }
    if (conv.persona && !candidate.personas.some((p) => p.id === conv.persona!.id)) candidate.personas.push(conv.persona);
    if (candidate.tasks.some((x) => x.id === conv.task.id)) rowProblem ??= `a task with id ${conv.task.id} already exists`;
    candidate.tasks = [...candidate.tasks, conv.task];
    // Problems with existing invariants are not this task's: validate reports them on the domain.
    const problems = rowProblem ? [rowProblem] : validateDomain(candidate).filter((p) => !p.startsWith("invariants."));
    if (problems.length) {
      out.warnings.push(`${t.file}: dropped ${conv.task.id}: ${problems.join("; ")}`);
      continue;
    }

    // A reused row that contradicts the transcript changes the scenario: keep the task for review, and say where.
    const conflicts = reusedRowConflicts(candidate, response.parsed_output.existing_rows ?? []);
    for (const c of conflicts) out.warnings.push(`${t.file}: ${conv.task.id} ${c}: keep the transcript's facts by giving the task its own row with new IDs, or correct the task`);
    const notes = conflicts.map((c) => `${c[0]!.toUpperCase()}${c.slice(1)}. Keep the transcript's facts: give this task its own row with new IDs, or correct the task.`);
    // Lint the task as `sandtable lint` would, replaying its drafted reference: a draft that can't be passed is kept for
    // review, with why. A failing reference usually points at a wrong expectation or a missing seed row.
    const lint = lintDomain({ ...candidate, tasks: [conv.task] }).tasks[0]!;
    for (const e of lint.errors) out.warnings.push(`${t.file}: ${conv.task.id}: ${e}`);
    notes.push(...lint.errors.map((e) => `lint: ${e}. Fix the expectation, the seed rows or the reference.`));
    // Names, usernames, emails and phone numbers from the chat that the draft kept: each must become a fictional value.
    const copied = copiedValueNotes(t.text, t.file, draftedPlaces(conv), known);
    if (copied.length) out.warnings.push(`${t.file}: ${conv.task.id}: ${copied.length} value(s) copied from the chat: see its TODO(review) notes`);
    out.copied += copied.length;
    notes.push(...copied);
    if (notes.length) out.notes[conv.task.id] = notes;

    domain = candidate;
    out.tasks.push(conv.task);
    if (conv.persona && !input.domain.personas.some((p) => p.id === conv.persona!.id) && !out.personas.some((p) => p.id === conv.persona!.id)) {
      out.personas.push(conv.persona);
    }
    for (const [table, rows] of Object.entries(conv.rows)) (out.rows[table] ??= []).push(...rows);
  }
  return out;
}
