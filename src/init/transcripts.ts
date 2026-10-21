import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { validateDomain } from "../spec/load.ts";
import { PersonaSpec, TaskSpec, type Domain, type Persona, type Task } from "../spec/schema.ts";
import { createClient, requestBase, type ClaudeOptions } from "../sim/claude.ts";
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
  const Condition = z.object({ field: z.string(), op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte"]), value: Scalar });
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
      .array(z.object({ table: Table, conditions: z.array(Condition), count: z.number().int().nullable() }))
      .describe("end state if the agent follows the policy: rows matching the conditions, exactly `count` of them (null = at least one)"),
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
- the tools that must and must not be called, only when the policy makes that clear.

Make everything fictional. Replace people's names, company names and identifiers with fictional ones. Use only the listed tables, fields and tools. Prefer exact conditions on keys (e.g. which load was booked by which carrier) and ranges for negotiated numbers.

Keep the transcript's facts. Reuse an existing row only when every fact the transcript states about it matches the row: a membership level, status, date, amount or item that differs means it is not the same record, even when the name matches (the same customer may have called before, with different facts then). Otherwise propose new_rows with new identifiers and every field the scenario needs, including the table key, consistent with the conditions you expect. Never change what the transcript says to fit an existing row, and never invent a conflict the transcript does not have. List each existing row you reuse in existing_rows, with the facts the transcript states about it.`;

function describe(domain: Domain): string {
  const tools = domain.tools
    .map((t) => `- ${t.name}(${Object.entries(t.params).map(([n, p]) => `${n}: ${p.type}${p.required ? "" : "?"}`).join(", ")}): ${t.description}`)
    .join("\n");
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

export function proposalToTask(p: Proposal, file: string): { task: Task; persona?: Persona; rows: Record<string, Record<string, unknown>[]> } | string {
  const where = (conds: Proposal["expect_state"][number]["conditions"]) =>
    Object.fromEntries(conds.map((c) => [c.field, c.op === "eq" ? c.value : { [`$${c.op}`]: c.value }]));
  const task = TaskSpec.safeParse({
    id: p.id,
    description: p.description,
    persona: p.persona_id,
    tags: p.tags,
    review: "pending",
    source: { file, quote: p.quote },
    user: { instructions: p.instructions, ...(p.script.length ? { script: p.script } : {}) },
    expect: {
      state: p.expect_state.map((s) => ({ table: s.table, where: where(s.conditions), ...(s.count === null ? {} : { count: s.count }) })),
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
  const out: TranscriptDraft = { tasks: [], personas: [], rows: {}, warnings: [], notes: {}, redactions: 0 };
  let domain = input.domain;

  for (const t of input.transcripts) {
    const scrubbed = scrubPii(t.text);
    out.redactions += scrubbed.redactions;
    const schema = outputSchema(domain.tools.map((x) => x.name), Object.keys(domain.world.tables));
    const response = await client.beta.messages.parse({
      ...base,
      output_config: { ...base.output_config, format: betaZodOutputFormat(schema) },
      system: SYSTEM,
      messages: [{ role: "user", content: `${describe(domain)}\n\n<transcript file="${t.file}">\n${scrubbed.text}\n</transcript>` }],
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) {
      out.warnings.push(`${t.file}: no usable proposal`);
      continue;
    }
    const conv = proposalToTask(response.parsed_output, t.file);
    if (typeof conv === "string") {
      out.warnings.push(`${t.file}: dropped: ${conv}`);
      continue;
    }

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
    if (conflicts.length) out.notes[conv.task.id] = conflicts.map((c) => `${c[0]!.toUpperCase()}${c.slice(1)}. Keep the transcript's facts: give this task its own row with new IDs, or correct the task.`);

    domain = candidate;
    out.tasks.push(conv.task);
    if (conv.persona && !input.domain.personas.some((p) => p.id === conv.persona!.id) && !out.personas.some((p) => p.id === conv.persona!.id)) {
      out.personas.push(conv.persona);
    }
    for (const [table, rows] of Object.entries(conv.rows)) (out.rows[table] ??= []).push(...rows);
  }
  return out;
}
