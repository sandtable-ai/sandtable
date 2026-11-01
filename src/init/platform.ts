/**
 * What `sandtable import` shares across voice platforms (Vapi, Retell, ElevenLabs): the draft it builds from an
 * agent's export, the tools every platform has (end the call, transfer it), how a test's tool mocks become a task's
 * rows or a tool's answer, and the renderer that writes the draft as sandtable.yaml and tasks.yaml with review notes.
 */

import YAML from "yaml";
import { httpProblems } from "../spec/load.ts";
import { isPlainObject } from "../world/match.ts";
import { slug, snake, toParam, uniqueName, type DraftParam } from "./openapi.ts";
import { flow, flowParam, paramYaml } from "./render.ts";

export type Json = Record<string, unknown>;

/** One JSON file of the export, by its path as given. */
export interface PlatformFile {
  file: string;
  json: unknown;
}

/** A tool in a task's `called` or `not_called`: its name, or the name and the arguments the call must have. */
export type DraftCall = string | { tool: string; args: Json };

export interface PlatformTool {
  name: string;
  /** Its name in the platform's config, which tests' tool mocks use, when it isn't a valid tool name. */
  platformName?: string;
  description: string;
  params: Record<string, DraftParam>;
  ops: Json[];
  http?: { method: string; path: string };
  /**
   * Review notes rendered as comments above the tool. The first says what the tool does, and a mock that drafts its
   * ops replaces it; the others, about its params and its route, stay.
   */
  notes: string[];
}

export interface PlatformTask {
  id: string;
  description: string;
  source: string;
  instructions: string;
  /** The caller's lines, when the test gives them; otherwise "Hi." placeholders. */
  opening?: string;
  script?: string[];
  context?: Json;
  rows?: Record<string, Json[]>;
  called: DraftCall[];
  notCalled?: DraftCall[];
  maxTurns?: number;
  notes: string[];
}

export interface PlatformDraft {
  name: string;
  description: string;
  policy: string;
  tables: Record<string, { key: string }>;
  tools: PlatformTool[];
  tasks: PlatformTask[];
  warnings: string[];
}

export const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
/** A tool argument's name, as model APIs accept it. */
export const PARAM_NAME = /^[a-zA-Z0-9_.-]{1,64}$/;

export const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

/** "a" or "an" before a type name, as it is read aloud: "an mcp tool", "a code tool". */
export const article = (word: string) => (/^([aeiou]|mcp\b|sms\b)/i.test(word) ? "an" : "a");

/** The items of a JSON file: the value itself, or each element of a list. */
export const itemsOf = (json: unknown): unknown[] => (Array.isArray(json) ? json : [json]);

/** The items whose names or ids include `agent`, or all of them when no `--agent` was given. */
export function picked<T>(items: T[], agent: string | undefined, keys: (item: T) => (string | undefined)[]): T[] {
  return agent === undefined ? items : items.filter((item) => keys(item).includes(agent));
}

/** A tool name the model APIs accept, made from the platform's, with a warning when it differs. */
export function toolName(raw: string, names: Set<string>, what: string, warnings: string[]): string {
  const name = uniqueName(names, TOOL_NAME.test(raw) ? raw : snake(raw));
  if (name !== raw) warnings.push(`${what} "${raw}" is tool "${name}": tool names match ${TOOL_NAME.source}`);
  return name;
}

/** Params from a JSON Schema object's properties, with a note on each one it can't map, type or name. */
export function schemaParams(schema: unknown, platform: string, notes: string[]): Record<string, DraftParam> {
  const params: Record<string, DraftParam> = {};
  const s = isPlainObject(schema) ? schema : {};
  const required = new Set(Array.isArray(s.required) ? s.required.map(String) : []);
  for (const [p, prop] of Object.entries(isPlainObject(s.properties) ? s.properties : {})) {
    const raw = isPlainObject(prop) ? prop : {};
    // A schema of several types, or a reference the config doesn't hold, isn't a type the draft can pick.
    const param = ["anyOf", "oneOf", "allOf", "$ref"].some((k) => k in raw) ? undefined : toParam(raw, (x) => x, required.has(p));
    if (!param) {
      notes.push(`Parameter "${p}" has a schema the draft can't map, so it was left out: add it by hand.`);
      continue;
    }
    params[p] = param;
    if (raw.type === undefined && raw.enum === undefined && raw.properties === undefined) notes.push(`Parameter "${p}" has no type in the ${platform} config, so it was drafted as a string: check it.`);
    if (!PARAM_NAME.test(p)) notes.push(`Parameter "${p}" has a name model APIs reject (they take ${PARAM_NAME.source}): rename it here and in the agent's tool.`);
  }
  return params;
}

/** A built-in tool's name as a valid tool name, and the platform's when it differs, for the mocks that use it. */
function builtinName(names: Set<string>, raw: string): Pick<PlatformTool, "name" | "platformName"> {
  const name = uniqueName(names, TOOL_NAME.test(raw) ? raw : snake(raw));
  return { name, ...(name !== raw ? { platformName: raw } : {}) };
}

/** A tool that ends the call. */
export function endCallTool(names: Set<string>, name: string, description = "End the call."): PlatformTool {
  return { ...builtinName(names, name), description, params: {}, ops: [{ respond: { status: "ended" } }], notes: [] };
}

/** Where a transfer goes: `target` is the value the agent passes, when the config names one. */
export interface TransferDestination {
  target?: string;
  label: string;
  description?: string;
}

/** A tool that transfers the call: each transfer is a row of the `transfers` table, which the caller adds. */
export function transferTool(names: Set<string>, name: string, destinations: TransferDestination[], platform: string, description = "Transfer the call to a person."): PlatformTool {
  const targets = [...new Set(destinations.map((d) => d.target).filter((x): x is string => x !== undefined))];
  const where = destinations.map((d) => `${d.label}${d.description ? ` (${d.description})` : ""}`).join("; ");
  return {
    ...builtinName(names, name),
    description: `${description}${where ? ` Destinations: ${where}.` : ""}`,
    params: { destination: { type: "string", required: true, ...(targets.length ? { enum: targets } : {}), description: "Where to transfer the call" } },
    ops: [{ create: "transfers", values: { destination: "$destination" } }, { respond: { status: "transferred", destination: "$destination" } }],
    notes: [`${platform} carries out a transfer itself, so with sandtable serve this tool is never called: grade a transfer there by the transcript. In a run, a transfer is a transfers row.`],
  };
}

/** The warning for `{{variables}}` in the prompt, or undefined when it has none. */
export function templateWarning(prompt: string): string | undefined {
  const templated = [...new Set(prompt.match(/\{\{\s*[^}]+\}\}/g) ?? [])];
  if (!templated.length) return undefined;
  return `the prompt uses template variables (${templated.join(", ")}): sandtable doesn't fill them, so give their values in a task's given.context, which the agent is shown`;
}

/** The tool a call expectation names. */
export const callTool = (call: DraftCall) => (typeof call === "string" ? call : call.tool);

/** Adds `call` to a task's expected calls, unless one of the same tool is there already. */
export function addCall(calls: DraftCall[], call: DraftCall) {
  if (!calls.some((c) => callTool(c) === callTool(call))) calls.push(call);
}

/** A tool's notes that outlast the note about what it does: those about its params and its route. */
const lastingNotes = (tool: PlatformTool) => tool.notes.slice(1);

/**
 * What the tool mocks of a platform's tests make of the draft: rows of a table per mocked tool, given to each task
 * alone, so two tests can mock the same tool differently, or the text the tool answers with in every task.
 */
export class Mocks {
  /** Per mocked tool: its table and key, once one test has decided them, or the text it answers with. */
  private readonly mocked = new Map<string, { table: string; key: string; param?: string } | { respond: string }>();
  private readonly tables: Record<string, { key: string }>;
  private readonly test: string;

  /** `tables` are the draft's, which mocked records add to; `test` is what the platform calls a test, such as "scenario". */
  constructor(tables: Record<string, { key: string }>, test: string) {
    this.tables = tables;
    this.test = test;
  }

  /** Adds what `tool` returns in `task`, as `file`'s mock says, and expects the task to call it. */
  add(task: PlatformTask, tool: PlatformTool, result: unknown, file: string, call: DraftCall = tool.name) {
    addCall(task.called, call);
    const rows = mockRows(result);
    if (!rows) {
      // Text, not records: the tool answers with it, in every task.
      const text = typeof result === "string" ? result : JSON.stringify(result);
      const known = this.mocked.get(tool.name);
      if (!known) {
        this.mocked.set(tool.name, { respond: text });
        tool.ops = [{ respond: text }];
        tool.notes = [`It answers with the text a ${this.test} mocked (${file}). Replace it with ops on a table if the answer depends on the arguments.`, ...lastingNotes(tool)];
      } else if (!("respond" in known) || known.respond !== text) {
        task.notes.push(`Its mock of ${tool.name} answers with other text than the one the tool's respond op has; model the difference with a table and given.rows.`);
      }
      return;
    }
    let shape = this.mocked.get(tool.name);
    if (!shape || "respond" in shape) {
      const table = uniqueId(new Set(Object.keys(this.tables)), `${snake(tool.name)}_results`);
      // The key: a required scalar param that the mocked records have as a field, so the tool looks one up.
      const param = Object.entries(tool.params).find(([p, d]) => d.required && d.type !== "object" && d.type !== "array" && rows.every((r) => r[p] !== undefined))?.[0];
      shape = { table, key: param ?? "id", ...(param ? { param } : {}) };
      this.mocked.set(tool.name, shape);
      this.tables[table] = { key: shape.key };
      tool.ops = [param ? { get: table, key: `$${param}` } : { list: table }];
      tool.notes = [
        `Drafted from the tool mocks of the ${this.test}s: it ${param ? `looks up a ${table} row by ${param}` : `lists the ${table} rows`}, and each task's given.rows holds what its ${this.test} mocked. Add the writes it makes, if any.`,
        ...lastingNotes(tool),
      ];
    }
    const { table, key } = shape;
    task.rows ??= {};
    const list = (task.rows[table] ??= []);
    for (const row of rows) {
      const keyed = row[key] === undefined ? { [key]: `${task.id}-${list.length + 1}`, ...row } : row;
      // Mocking the same record twice, as for a repeated lookup, is one row.
      if (list.some((r) => String(r[key]) === String(keyed[key]))) continue;
      list.push(keyed);
    }
  }
}

/**
 * The notes every imported task ends with: what it grades, and whether the caller's lines are placeholders. `checked`
 * says what its expectations come from, when not from the `test`'s tool mocks.
 */
export function closeTask(task: PlatformTask, test: string, checked?: string) {
  const calls = task.called.map(callTool);
  if (!calls.length && !task.notCalled?.length) task.notes.push("Nothing is graded yet: add the end state (expect.state) or the tools a correct call uses (expect.called).");
  else task.notes.push(checked ?? `The ${test} mocked ${calls.join(", ")}, so the task expects a successful call of each: check that, and add the end state.`);
  if (!task.script) task.notes.push("Its opening and script are placeholders for runs with --user scripted: write the caller's lines.");
}

/** A mock's result as rows: a JSON object, or a list of them, given as JSON text or as the value itself. */
export function mockRows(result: unknown): Json[] | undefined {
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

export function uniqueId(seen: Set<string>, base: string): string {
  let id = base || "task";
  for (let i = 2; seen.has(id); i++) id = `${base}-${i}`;
  seen.add(id);
  return id;
}

/** A unique task id from a test's name. */
export const taskId = (seen: Set<string>, name: string) => uniqueId(seen, slug(name));

/** The param at a dotted path, such as "address.zip", or undefined when the tool has none there. */
export function paramAt(params: Record<string, DraftParam>, name: string): DraftParam | undefined {
  if (Object.hasOwn(params, name)) return params[name];
  const [root, ...rest] = name.split(".");
  let p = Object.hasOwn(params, root!) ? params[root!] : undefined;
  for (const seg of rest) {
    if (p?.type === "object" && p.properties && Object.hasOwn(p.properties, seg)) p = p.properties[seg];
    else if (p?.type === "array" && /^\d+$/.test(seg)) p = p.items;
    else return undefined;
  }
  return p;
}

/**
 * A call of `tool` with the arguments in `args` that are its params, by name or dotted path, or the tool alone when
 * none is. `leftOut` is the note for an argument that isn't one, which `validate` would reject.
 */
export function expectedCall(tool: PlatformTool, args: Json, notes: string[], leftOut: (field: string, value: unknown) => string): DraftCall {
  const kept: Json = {};
  for (const [field, value] of Object.entries(args)) {
    if (paramAt(tool.params, field)) kept[field] = value;
    else notes.push(leftOut(field, value));
  }
  return Object.keys(kept).length ? { tool: tool.name, args: kept } : tool.name;
}

/**
 * Why `tool` can't have the route `http`, by the checks `validate` makes: a placeholder that isn't a scalar param, a
 * route the world server keeps for itself, or one another tool in `routes` has. Undefined when it can, and `routes`
 * then holds it.
 */
export function routeProblem(tool: PlatformTool, http: { method: string; path: string }, routes: Map<string, string>): string | undefined {
  // The spec's own pattern for a path, which validate checks before httpProblems runs.
  if (!/^\/[^?#\s]*$/.test(http.path)) return `the path ${JSON.stringify(http.path)} has a space or a character a route can't`;
  const prefix = `tools.${tool.name}.http: `;
  const problems = httpProblems({ name: tool.name, params: tool.params, http }, routes);
  return problems.length ? problems.map((p) => (p.startsWith(prefix) ? p.slice(prefix.length) : p)).join("; ") : undefined;
}

/** What the renderer says about the platform an import came from. */
export interface ImportText {
  /** Where the draft came from, such as "a Vapi assistant". */
  from: string;
  /** The import command, such as "import vapi". */
  command: string;
  /** How to get tests to import, for a draft with none. */
  noTasks: string;
}

/** The draft as sandtable.yaml and tasks.yaml, with review notes as YAML comments next to what they concern. */
export function renderPlatformDraft(d: PlatformDraft, text: ImportText): { domain: string; tasks: string } {
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
      ...(t.http ? { http: t.http } : {}),
      ...(t.notes.length ? { review: "pending" } : {}),
    })),
    invariants: [],
    tasks: "./tasks.yaml",
  });
  doc.commentBefore = [
    ` Imported from ${text.from} by \`npx sandtable-ai ${text.command}\`.`,
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
    if (t.http) flow(doc.getIn(["tools", i, "http"], true));
    const node = doc.getIn(["tools", i], true) as YAML.Node | undefined;
    if (node && t.notes.length) node.commentBefore = t.notes.map((n) => ` TODO(review): ${n}`).join("\n");
  });

  const tasks = new YAML.Document(
    d.tasks.map((t) => ({
      id: t.id,
      description: t.description,
      review: "pending",
      source: { file: t.source },
      user: { instructions: t.instructions, opening: t.opening ?? "Hi.", script: t.script ?? ["Hi."] },
      ...(t.rows || t.context ? { given: { ...(t.rows ? { rows: t.rows } : {}), ...(t.context ? { context: t.context } : {}) } } : {}),
      expect: { ...(t.called.length ? { called: t.called } : {}), ...(t.notCalled?.length ? { not_called: t.notCalled } : {}) },
      ...(t.maxTurns !== undefined ? { max_turns: t.maxTurns } : {}),
    })),
  );
  d.tasks.forEach((t, i) => {
    for (const list of ["called", "not_called"]) {
      (list === "called" ? t.called : (t.notCalled ?? [])).forEach((c, j) => {
        if (typeof c !== "string") flow(tasks.getIn([i, "expect", list, j, "args"], true));
      });
    }
    const node = tasks.get(i, true) as YAML.Node | undefined;
    if (node) node.commentBefore = t.notes.map((n) => ` TODO(review): ${n}`).join("\n");
  });
  return { domain: doc.toString({ lineWidth: 0 }), tasks: d.tasks.length ? tasks.toString({ lineWidth: 0 }) : `# TODO: add tasks, or ${text.noTasks} and import them with it.\n[]\n` };
}
