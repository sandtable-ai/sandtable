/**
 * `sandtable import vapi`: a draft domain from a Vapi assistant's config, with no model call. The system prompt
 * becomes the policy, the function tools and the transferCall and endCall tools become tools, and simulation
 * scenarios become tasks: the tester's instructions as the caller's goal, the scenario's tool mocks as that task's
 * seed rows, and its variable values as the call's context. What the config can't say, such as what a tool changes
 * or how a scenario is graded, becomes a review note, as `init` does.
 */

import YAML from "yaml";
import { isPlainObject } from "../world/match.ts";
import { slug, snake, toParam, uniqueName, type DraftParam } from "./openapi.ts";
import { flow, flowParam, paramYaml, POLICY_PLACEHOLDER } from "./render.ts";

type Json = Record<string, unknown>;

/** One JSON file of the export, by its path as given. */
export interface VapiFile {
  file: string;
  json: unknown;
}

export interface VapiTool {
  name: string;
  description: string;
  params: Record<string, DraftParam>;
  ops: Json[];
  notes: string[];
}

export interface VapiTask {
  id: string;
  description: string;
  source: string;
  instructions: string;
  context?: Json;
  rows?: Record<string, Json[]>;
  called: string[];
  notes: string[];
}

export interface VapiDraft {
  name: string;
  description: string;
  policy: string;
  tables: Record<string, { key: string }>;
  tools: VapiTool[];
  tasks: VapiTask[];
  warnings: string[];
}

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
/** Tool types Vapi runs itself, with no server, that a draft can't model. */
const SKIPPED_TYPES = new Set(["dtmf", "voicemail", "query", "sms", "handoff", "code", "bash", "computer", "textEditor", "output", "mcp", "apiRequest"]);

const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

/** The assistant, tools and simulation scenarios among an export's files, by shape. Arrays hold several. */
function classify(files: VapiFile[], warnings: string[]) {
  const assistants: { file: string; json: Json }[] = [];
  const tools: { file: string; json: Json }[] = [];
  const scenarios: { file: string; json: Json }[] = [];
  for (const { file, json } of files) {
    for (const item of Array.isArray(json) ? json : [json]) {
      if (!isPlainObject(item)) {
        warnings.push(`${file}: not a JSON object or a list of them; skipped`);
      } else if (isPlainObject(item.model)) {
        assistants.push({ file, json: item });
      } else if (typeof item.instructions === "string") {
        scenarios.push({ file, json: item });
      } else if (typeof item.type === "string") {
        tools.push({ file, json: item });
      } else {
        warnings.push(`${file}: not a Vapi assistant (with model), tool (with type) or simulation scenario (with instructions); skipped`);
      }
    }
  }
  return { assistants, tools, scenarios };
}

/** Why the files can't be imported, or undefined when they hold exactly one assistant. */
export function vapiProblem(files: VapiFile[]): string | undefined {
  const { assistants } = classify(files, []);
  if (assistants.length === 0) return "has no Vapi assistant: export one with GET https://api.vapi.ai/assistant/<id> and import that JSON";
  if (assistants.length > 1) return `has ${assistants.length} assistants (${assistants.map((a) => str(a.json.name) ?? a.file).join(", ")}): import one at a time`;
  return undefined;
}

export function draftFromVapi(files: VapiFile[]): VapiDraft {
  const warnings: string[] = [];
  const { assistants, tools: toolFiles, scenarios } = classify(files, warnings);
  const { json: assistant, file: assistantFile } = assistants[0]!;
  const model = assistant.model as Json;
  const title = str(assistant.name) ?? "vapi-assistant";

  // The system prompt is the policy; the first message is how the assistant opens.
  const system = (Array.isArray(model.messages) ? model.messages : [])
    .filter((m): m is Json => isPlainObject(m) && m.role === "system" && typeof m.content === "string")
    .map((m) => String(m.content).trim())
    .filter(Boolean);
  if (system.length === 0) warnings.push(`${assistantFile}: the assistant has no system message, so policy.md is a placeholder`);
  const opening = str(assistant.firstMessage);
  const policy = system.length
    ? `# ${title}\n\n${system.join("\n\n")}\n${opening ? `\nOpen each call with: "${opening}"\n` : ""}`
    : POLICY_PLACEHOLDER;
  const templated = [...new Set(system.join("\n").match(/\{\{\s*[^}]+\}\}/g) ?? [])];
  if (templated.length) {
    warnings.push(`the prompt uses template variables (${templated.join(", ")}): sandtable doesn't fill them, so give their values in a task's given.context, which the agent is shown`);
  }

  // The assistant's tools: inline in model.tools, and those model.toolIds names from the export's tool files.
  const ids = new Set(Array.isArray(model.toolIds) ? model.toolIds.filter((x): x is string => typeof x === "string") : []);
  const byId = new Map(toolFiles.filter((t) => typeof t.json.id === "string").map((t) => [t.json.id as string, t]));
  const used: { file: string; json: Json }[] = (Array.isArray(model.tools) ? model.tools : []).filter(isPlainObject).map((json) => ({ file: assistantFile, json }));
  for (const id of ids) {
    const t = byId.get(id);
    if (t) used.push(t);
    else warnings.push(`model.toolIds names ${id}, which no file in the export has: add it with GET https://api.vapi.ai/tool/${id}`);
  }
  for (const t of toolFiles) {
    if (typeof t.json.id !== "string" || !ids.has(t.json.id)) warnings.push(`${t.file}: a tool the assistant doesn't use (it isn't in model.toolIds); skipped`);
  }

  const names = new Set<string>();
  const tools: VapiTool[] = [];
  const tables: Record<string, { key: string }> = {};
  for (const { file, json } of used) {
    const tool = toolFrom(json, file, names, warnings);
    if (!tool) continue;
    tools.push(tool);
    if (json.type === "transferCall") tables.transfers = { key: "transfer_id" };
  }

  // Each scenario is a task. Its tool mocks are what those tools return in it: rows of a table per tool, given to
  // that task alone, so two scenarios can mock the same tool differently.
  const taskIds = new Set<string>();
  const tasks: VapiTask[] = [];
  /** Per mocked tool: its table and key, once one scenario has decided them. */
  const mocked = new Map<string, { table: string; key: string; param?: string } | { respond: string }>();
  for (const { file, json } of scenarios) {
    const name = str(json.name) ?? `scenario ${tasks.length + 1}`;
    const task: VapiTask = { id: uniqueId(taskIds, slug(name)), description: name, source: file, instructions: String(json.instructions).trim(), called: [], notes: [] };
    const variables = isPlainObject(json.targetOverrides) && isPlainObject(json.targetOverrides.variableValues) ? json.targetOverrides.variableValues : undefined;
    if (variables && Object.keys(variables).length) task.context = variables;
    for (const mock of Array.isArray(json.toolMocks) ? json.toolMocks : []) {
      if (!isPlainObject(mock) || mock.enabled === false) continue;
      const toolName = str(mock.toolName);
      const tool = tools.find((t) => t.name === toolName);
      if (!tool) {
        warnings.push(`${file}: a tool mock for ${toolName ?? "a tool with no toolName"}, which the assistant doesn't have; skipped`);
        continue;
      }
      if (!task.called.includes(tool.name)) task.called.push(tool.name);
      const rows = mockRows(mock.result);
      if (!rows) {
        // Text, not records: the tool answers with it, in every task.
        const text = typeof mock.result === "string" ? mock.result : JSON.stringify(mock.result);
        const known = mocked.get(tool.name);
        if (!known) {
          mocked.set(tool.name, { respond: text });
          tool.ops = [{ respond: text }];
          tool.notes = [`It answers with the text a scenario mocked (${file}). Replace it with ops on a table if the answer depends on the arguments.`];
        } else if (!("respond" in known) || known.respond !== text) {
          task.notes.push(`Its mock of ${tool.name} answers with other text than the one the tool's respond op has; model the difference with a table and given.rows.`);
        }
        continue;
      }
      let shape = mocked.get(tool.name);
      if (!shape || "respond" in shape) {
        const table = uniqueId(new Set(Object.keys(tables)), `${snake(tool.name)}_results`);
        // The key: a required scalar param that the mocked records have as a field, so the tool looks one up.
        const param = Object.entries(tool.params).find(([p, d]) => d.required && d.type !== "object" && d.type !== "array" && rows.every((r) => r[p] !== undefined))?.[0];
        shape = { table, key: param ?? "id", ...(param ? { param } : {}) };
        mocked.set(tool.name, shape);
        tables[table] = { key: shape.key };
        tool.ops = [param ? { get: table, key: `$${param}` } : { list: table }];
        tool.notes = [
          `Drafted from the tool mocks of the scenarios: it ${param ? `looks up a ${table} row by ${param}` : `lists the ${table} rows`}, and each task's given.rows holds what its scenario mocked. Add the writes it makes, if any.`,
        ];
      }
      const { table, key } = shape;
      task.rows ??= {};
      const list = (task.rows[table] ??= []);
      rows.forEach((row) => list.push(row[key] === undefined ? { [key]: `${task.id}-${list.length + 1}`, ...row } : row));
    }
    for (const ev of Array.isArray(json.evaluations) ? json.evaluations : []) {
      if (!isPlainObject(ev)) continue;
      const output = str(ev.structuredOutputId) ?? (isPlainObject(ev.structuredOutput) ? (str(ev.structuredOutput.name) ?? "an inline structured output") : "a structured output");
      task.notes.push(`Vapi graded it with ${output} ${String(ev.comparator ?? "=")} ${JSON.stringify(ev.value)}: write that as expect.state, called or not_called, which sandtable grades without a model.`);
    }
    if (!task.called.length) task.notes.push("Nothing is graded yet: add the end state (expect.state) or the tools a correct call uses (expect.called).");
    else task.notes.push(`The scenario mocked ${task.called.join(", ")}, so the task expects a successful call of each: check that, and add the end state.`);
    task.notes.push("Its opening and script are placeholders for runs with --user scripted: write the caller's lines.");
    tasks.push(task);
  }

  return {
    name: slug(title),
    description: `Imported from the Vapi assistant "${title}" (${assistantFile}). Every tool, table and task is a draft to review.`,
    policy,
    tables,
    tools,
    tasks,
    warnings,
  };
}

/** A Vapi tool as a sandtable tool, or undefined for a type the draft can't model. */
function toolFrom(json: Json, file: string, names: Set<string>, warnings: string[]): VapiTool | undefined {
  const type = String(json.type);
  if (type === "function") {
    const fn = isPlainObject(json.function) ? json.function : {};
    const raw = str(fn.name);
    if (!raw) {
      warnings.push(`${file}: a function tool with no function.name; skipped`);
      return undefined;
    }
    const name = uniqueName(names, TOOL_NAME.test(raw) ? raw : snake(raw));
    if (name !== raw) warnings.push(`${file}: function "${raw}" is tool "${name}": tool names match ${TOOL_NAME.source}`);
    const params: Record<string, DraftParam> = {};
    const schema = isPlainObject(fn.parameters) ? fn.parameters : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
    const notes: string[] = [];
    for (const [p, s] of Object.entries(isPlainObject(schema.properties) ? schema.properties : {})) {
      const param = toParam(isPlainObject(s) ? s : {}, (x) => x, required.has(p));
      if (param) params[p] = param;
      else notes.push(`Parameter "${p}" has a schema the draft can't map, so it was left out: add it by hand.`);
    }
    const server = isPlainObject(json.server) ? str(json.server.url) : undefined;
    notes.unshift(
      `No scenario mocks it, so what it returns is unknown: model what it reads and changes with get, list, create or update ops on a table${server ? ` (Vapi calls ${server} for it)` : ""}.`,
    );
    return { name, description: str(fn.description) ?? `${name} (no description in the Vapi config: write one for the model)`, params, ops: [{ respond: { status: "ok" } }], notes };
  }
  if (type === "transferCall") {
    const destinations = (Array.isArray(json.destinations) ? json.destinations : []).filter(isPlainObject);
    const targets = destinations.map((d) => str(d.number) ?? str(d.sipUri) ?? str(d.assistantName)).filter((x): x is string => x !== undefined);
    const where = destinations.map((d) => `${str(d.number) ?? str(d.sipUri) ?? str(d.assistantName) ?? "?"}${str(d.description) ? ` (${str(d.description)})` : ""}`).join("; ");
    return {
      name: uniqueName(names, "transferCall"),
      description: `Transfer the call to a person.${where ? ` Destinations: ${where}.` : ""}`,
      params: { destination: { type: "string", required: true, ...(targets.length ? { enum: targets } : {}), description: "Where to transfer the call" } },
      ops: [{ create: "transfers", values: { destination: "$destination" } }, { respond: { status: "transferred", destination: "$destination" } }],
      notes: ["Vapi carries out a transfer itself, so with sandtable serve this tool is never called: grade a transfer there by the transcript. In a run, a transfer is a transfers row."],
    };
  }
  if (type === "endCall") {
    return { name: uniqueName(names, "endCall"), description: "End the call.", params: {}, ops: [{ respond: { status: "ended" } }], notes: [] };
  }
  warnings.push(`${file}: a ${type} tool${SKIPPED_TYPES.has(type) ? ", which Vapi runs itself," : ""} has no sandtable counterpart; skipped`);
  return undefined;
}

/** A mock's result as rows: a JSON object, or a list of them, given as JSON text or as the value itself. */
function mockRows(result: unknown): Json[] | undefined {
  let value = result;
  if (typeof result === "string") {
    try {
      value = JSON.parse(result);
    } catch {
      return undefined;
    }
  }
  if (isPlainObject(value)) return [value];
  if (Array.isArray(value) && value.length && value.every(isPlainObject)) return value as Json[];
  return undefined;
}

function uniqueId(seen: Set<string>, base: string): string {
  let id = base || "task";
  for (let i = 2; seen.has(id); i++) id = `${base}-${i}`;
  seen.add(id);
  return id;
}

/** The draft as sandtable.yaml and tasks.yaml, with review notes as YAML comments next to what they concern. */
export function renderVapiDraft(d: VapiDraft): { domain: string; tasks: string } {
  const doc = new YAML.Document({
    name: d.name,
    description: d.description,
    policy: "./policy.md",
    world: { tables: Object.fromEntries(Object.entries(d.tables).map(([n, t]) => [n, { key: t.key }])) },
    tools: d.tools.map((t) => ({
      name: t.name,
      description: t.description,
      ...(Object.keys(t.params).length ? { params: Object.fromEntries(Object.entries(t.params).map(([k, p]) => [k, paramYaml(p)])) } : {}),
      ops: t.ops,
      ...(t.notes.length ? { review: "pending" } : {}),
    })),
    invariants: [],
    tasks: "./tasks.yaml",
  });
  doc.commentBefore = [
    " Imported from a Vapi assistant by `npx sandtable-ai import vapi`.",
    " Review every TODO, draft the rules from the prompt with `npx sandtable-ai init --sop <dir>/policy.md -o <dir>`,",
    " then run `npx sandtable-ai validate`.",
  ].join("\n");
  if (!Object.keys(d.tables).length) {
    const world = doc.getIn(["world", "tables"], true) as YAML.Node | undefined;
    if (world) world.commentBefore = " TODO: add the tables the tools read and change.";
  }
  d.tools.forEach((t, i) => {
    for (const [name, p] of Object.entries(t.params)) flowParam(doc, ["tools", i, "params", name], p);
    t.ops.forEach((op, j) => {
      for (const field of Object.keys(op)) flow(doc.getIn(["tools", i, "ops", j, field], true));
    });
    const node = doc.getIn(["tools", i], true) as YAML.Node | undefined;
    if (node && t.notes.length) node.commentBefore = t.notes.map((n) => ` TODO(review): ${n}`).join("\n");
  });

  const tasks = new YAML.Document(
    d.tasks.map((t) => ({
      id: t.id,
      description: t.description,
      review: "pending",
      source: { file: t.source },
      user: { instructions: t.instructions, opening: "Hi.", script: ["Hi."] },
      ...(t.rows || t.context ? { given: { ...(t.rows ? { rows: t.rows } : {}), ...(t.context ? { context: t.context } : {}) } } : {}),
      expect: { ...(t.called.length ? { called: t.called } : {}) },
    })),
  );
  d.tasks.forEach((t, i) => {
    const node = tasks.get(i, true) as YAML.Node | undefined;
    if (node) node.commentBefore = t.notes.map((n) => ` TODO(review): ${n}`).join("\n");
  });
  if (!d.tasks.length) tasks.commentBefore = " TODO: add tasks, or export the assistant's simulation scenarios and import them with it.";
  return { domain: doc.toString({ lineWidth: 0 }), tasks: d.tasks.length ? tasks.toString({ lineWidth: 0 }) : "# TODO: add tasks, or export the assistant's simulation scenarios (GET https://api.vapi.ai/eval/simulation/scenario/<id>) and import them with it.\n[]\n" };
}

