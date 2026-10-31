import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { expectedTool } from "../grade/expectations.ts";
import { mentions, protectedValues } from "../grade/invariants.ts";
import { agentSystemPrompt, taskContext } from "../sim/prompts.ts";
import { operatorProblems, substitute } from "../world/match.ts";
import { shellWord } from "../shell.ts";
import { version } from "../version.ts";
import { coerceArgs } from "../world/tools.ts";
import { seedFor } from "../world/store.ts";
import { DomainSpec, type Domain, type Given, type Task, type Tool } from "./schema.ts";

export const DOMAIN_FILE = "sandtable.yaml";

export class DomainError extends Error {}

/** No domain at the path: no sandtable.yaml there, or it can't be read. Unlike an invalid domain, there is nothing to check. */
export class DomainNotFoundError extends DomainError {}

/**
 * Load a domain from a directory containing sandtable.yaml (or the file itself).
 * Any top-level value that is a relative path to a .md/.yaml/.yml file is inlined,
 * so policy, world and tasks can live in their own files. A one-token path to a missing file is an
 * error, never the value itself: a misspelled `policy: ./polcy.md` would otherwise become the policy.
 */
export async function loadDomain(target: string): Promise<Domain> {
  const file = (await isDir(target)) ? path.join(target, DOMAIN_FILE) : target;
  const dir = path.dirname(file);
  const text = await readFile(file, "utf8").catch(() => {
    throw new DomainNotFoundError(`no ${DOMAIN_FILE} found at ${target} (create one, or draft it with \`npx sandtable-ai init\`)`);
  });
  const raw = parseYaml(text, file) as Record<string, unknown>;
  if (!raw || typeof raw !== "object") throw new DomainError(`${file} is empty or not a YAML mapping`);

  // The file each top-level key came from, so a problem is reported where it can be fixed.
  const sources = new Map<string, string>();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string" || !/\.(md|ya?ml)$/i.test(value.trim())) continue;
    const included = path.resolve(dir, value.trim());
    if (!(await exists(included))) {
      if (PATH.test(value.trim())) throw new DomainError(`${file}: ${key}: ${value.trim()} not found (looked for ${included})`);
      continue;
    }
    const text = await readFile(included, "utf8");
    raw[key] = /\.md$/i.test(included) ? text : parseYaml(text, included);
    sources.set(key, path.join(path.dirname(file), value.trim()));
  }
  const sourceOf = (key: unknown) => (typeof key === "string" && sources.get(key)) || file;

  const parsed = DomainSpec.safeParse(raw);
  if (!parsed.success) {
    const groups = groupBy(parsed.error.issues, (issue) => sourceOf(issue.path[0]));
    const unknown = parsed.error.issues.reduce((n, issue) => n + (issue.code === "unrecognized_keys" ? issue.keys.length : 0), 0);
    throw new DomainError([...groups].map(([f, issues]) => `${f}:\n${z.prettifyError(new z.ZodError(issues))}`).join("\n") + unknownKeysNote(unknown, target));
  }
  const problems = validateDomain(parsed.data);
  if (problems.length) {
    // Each problem starts with its top-level key, such as `tasks.book-load.expect` or `tools: duplicate tool`.
    const groups = groupBy(problems, (p) => sourceOf(/^[A-Za-z_]+/.exec(p)?.[0]));
    throw new DomainError([...groups].map(([f, lines]) => `${f}:\n${lines.map((p) => `  - ${p}`).join("\n")}`).join("\n"));
  }
  return parsed.data;
}

/**
 * After unknown keys, the installed version: a key that a later release added then reads differently from a typo,
 * for an engineer who read newer docs and for a coding agent that would otherwise go looking in node_modules.
 */
function unknownKeysNote(count: number, target?: string): string {
  if (count === 0) return "";
  const [these, their, them] = count === 1 ? ["this key", "its", "it"] : ["these keys", "their", "them"];
  // A domain built in code (parseDomain) has no path for the command to name.
  const check = target === undefined ? "CHANGELOG.md" : `CHANGELOG.md, or \`npx sandtable-ai@latest validate ${shellWord(target)}\``;
  return `\nsandtable-ai ${version} doesn't know ${these}: check ${their} spelling, or whether a later release added ${them} (${check}).`;
}


/**
 * A domain built in code, checked as loadDomain checks a file: the schema, then the cross-references. Unlike a
 * sandtable.yaml, its values are the values themselves: a path to a policy or tasks file is not read. Throws a
 * DomainError that says what is wrong.
 */
export function parseDomain(value: unknown): Domain {
  const parsed = DomainSpec.safeParse(value);
  if (!parsed.success) {
    const unknown = parsed.error.issues.reduce((n, issue) => n + (issue.code === "unrecognized_keys" ? issue.keys.length : 0), 0);
    throw new DomainError(z.prettifyError(parsed.error) + unknownKeysNote(unknown));
  }
  const problems = validateDomain(parsed.data);
  if (problems.length) throw new DomainError(problems.map((p) => `  - ${p}`).join("\n"));
  return parsed.data;
}

/** Items grouped by key, keys in the order they first appear. */
function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

/** Cross-reference checks the schema cannot express. Returns human-readable problems. */
export function validateDomain(d: Domain): string[] {
  const problems: string[] = [];
  const tables = new Set(Object.keys(d.world.tables));
  const tools = new Map(d.tools.map((t) => [t.name, t]));
  const table = (name: string, where: string) => {
    if (!tables.has(name)) problems.push(`${where}: unknown table "${name}"`);
  };
  const tool = (name: string, where: string) => {
    if (!tools.has(name)) problems.push(`${where}: unknown tool "${name}"`);
  };
  // Every where clause, at its path: `validate` catches what would throw or silently match nothing at run time.
  const operators = (clause: Record<string, unknown> | undefined, where: string, opts: { refs?: boolean } = {}) => {
    if (clause) for (const p of operatorProblems(clause, opts)) problems.push(`${where}.${p}`);
  };
  const arg = (toolName: string, name: string, where: string) => {
    const t = tools.get(toolName);
    // Own keys only: `in` would also find Object.prototype members such as toString or constructor.
    if (t && !Object.hasOwn(t.params, name)) problems.push(`${where}: tool "${toolName}" has no param "${name}"`);
  };
  // A where clause on a call's arguments may also name a nested one, such as "address.zip" or "items.0.sku".
  const argPath = (toolName: string, name: string, where: string) => {
    const t = tools.get(toolName);
    if (t && !paramAt(t.params, name)) problems.push(`${where}: tool "${toolName}" has no param "${name}"`);
  };

  for (const [name, t] of Object.entries(d.world.tables)) {
    const keys = new Set<string>();
    t.rows.forEach((row, i) => {
      const k = row[t.key];
      if (k === undefined) problems.push(`world.tables.${name}.rows[${i}]: missing key field "${t.key}"`);
      else if (keys.has(String(k))) problems.push(`world.tables.${name}: duplicate key ${String(k)}`);
      else keys.add(String(k));
    });
  }

  const seenTools = new Set<string>();
  for (const t of d.tools) {
    if (seenTools.has(t.name)) problems.push(`tools: duplicate tool "${t.name}"`);
    seenTools.add(t.name);
    t.checks.forEach((c, i) => {
      table(c.table, `tools.${t.name}.checks[${i}]`);
      operators(c.where, `tools.${t.name}.checks[${i}].where`, { refs: true });
    });
    t.ops.forEach((op, i) => {
      const name = "get" in op ? op.get : "list" in op ? op.list : "create" in op ? op.create : "update" in op ? op.update : undefined;
      if (name) table(name, `tools.${t.name}.ops[${i}]`);
      if ("list" in op) operators(op.where, `tools.${t.name}.ops[${i}].where`, { refs: true });
    });
    const unresolved = (value: unknown, where: string) => {
      for (const { ref, name, path } of references(value)) {
        const p = Object.hasOwn(t.params, name) ? t.params[name] : undefined;
        if (!path.length) {
          if (!p) problems.push(`${where}: "${ref}" never resolves: tool "${t.name}" has no param "${name}"`);
          continue;
        }
        // A path after a param with no fields stays literal text, as it did before params could nest.
        if (p && (p.type === "object" || p.type === "array") && !paramAt(t.params, [name, ...path].join("."))) {
          problems.push(`${where}: "${ref}" never resolves: param "${name}" has no "${path.join(".")}"`);
        }
      }
    };
    for (const [name, p] of Object.entries(t.params)) problems.push(...defaultProblems(p, `tools.${t.name}.params.${name}`));
    t.checks.forEach((c, i) => unresolved(c, `tools.${t.name}.checks[${i}]`));
    t.ops.forEach((op, i) => unresolved(op, `tools.${t.name}.ops[${i}]`));
    if (t.returns >= t.ops.length) problems.push(`tools.${t.name}: returns=${t.returns} but only ${t.ops.length} op(s)`);
  }

  const ids = new Set<string>();
  for (const inv of d.invariants) {
    const where = `invariants.${inv.id}`;
    if (ids.has(inv.id)) problems.push(`${where}: duplicate invariant id`);
    ids.add(inv.id);
    if ("before" in inv) {
      tool(inv.before.first, where);
      tool(inv.before.then, where);
      for (const a of inv.before.same) {
        arg(inv.before.first, a, where);
        arg(inv.before.then, a, where);
      }
    } else if ("require" in inv) {
      tool(inv.require.tool, where);
      table(inv.require.table, where);
      arg(inv.require.tool, inv.require.key_arg, where);
      operators(inv.require.where, `${where}.require.where`);
    } else if ("limit" in inv) {
      tool(inv.limit.tool, where);
      arg(inv.limit.tool, inv.limit.arg, where);
      for (const ref of [inv.limit.lte, inv.limit.gte, inv.limit.lt, inv.limit.gt]) {
        if (ref && typeof ref === "object") {
          table(ref.table, where);
          arg(inv.limit.tool, ref.key_arg, where);
        }
      }
    } else if ("match" in inv) {
      tool(inv.match.tool, where);
      for (const ref of [inv.match.left, inv.match.right]) {
        table(ref.table, where);
        arg(inv.match.tool, ref.key_arg, where);
      }
    } else if ("never_disclose" in inv) {
      table(inv.never_disclose.table, where);
      const blind = undetectable(d, inv.never_disclose.table, inv.never_disclose.field);
      if (blind) problems.push(`${where}: never_disclose can never fire on ${inv.never_disclose.table}.${inv.never_disclose.field}: ${blind}`);
      for (const u of [inv.never_disclose.unless ?? []].flat()) {
        tool(u.tool, where);
        arg(u.tool, u.arg, where);
      }
    } else {
      tool(inv.never.tool, where);
      operators(inv.never.when, `${where}.never.when`);
    }
  }

  const personas = new Set(d.personas.map((p) => p.id));
  const taskIds = new Set<string>();
  for (const task of d.tasks) {
    const where = `tasks.${task.id}`;
    if (taskIds.has(task.id)) problems.push(`${where}: duplicate task id`);
    taskIds.add(task.id);
    if (task.persona && !personas.has(task.persona)) problems.push(`${where}: unknown persona "${task.persona}"`);
    task.expect.state.forEach((a, i) => {
      table(a.table, `${where}.expect.state[${i}]`);
      operators(a.where, `${where}.expect.state[${i}].where`);
      operators(a.fields, `${where}.expect.state[${i}].fields`);
    });
    task.reference?.forEach((c, i) => tool(c.tool, `${where}.reference[${i}]`));
    if (task.given) problems.push(...givenProblems(d, task.given, `${where}.given`, tables));
    task.faults?.forEach((f, i) => tool(f.tool, `${where}.faults[${i}]`));
    if (task.events) problems.push(...eventProblems(d, task, where, tables, tool));
    for (const list of ["called", "not_called"] as const) {
      task.expect[list].forEach((e, i) => {
        tool(expectedTool(e), `${where}.expect`);
        if (typeof e === "string") return;
        for (const name of Object.keys(e.args)) argPath(e.tool, name, `${where}.expect.${list}[${i}]`);
        operators(e.args, `${where}.expect.${list}[${i}].args`);
      });
    }
  }
  return problems;
}

/**
 * What's wrong with a task's `events`: an unknown tool or table, an update of a row that may not exist when it fires, or
 * a create of a key that already exists. Events fire in the order the agent's calls come, which validate can't know, so
 * an update can count only on a row the task starts with, or one an earlier event after the same call creates.
 */
function eventProblems(d: Domain, task: Task, where: string, tables: Set<string>, tool: (name: string, where: string) => void): string[] {
  const problems: string[] = [];
  const seed = seedFor(d, task);
  const seeded = new Map(Object.entries(seed.tables).map(([name, t]) => [name, new Set(t.rows.map((r) => String(r[t.key])))]));
  /** Keys created by events, by table, with the call they follow. */
  const created = new Map<string, Map<string, string>>();
  task.events!.forEach((e, i) => {
    const at = `${where}.events[${i}]`;
    tool(e.after.tool, at);
    const table = "update" in e ? e.update : e.create;
    if (!tables.has(table)) {
      problems.push(`${at}: unknown table "${table}"`);
      return;
    }
    const after = `${e.after.tool} call ${e.after.call}`;
    const made = created.get(table) ?? new Map<string, string>();
    created.set(table, made);
    if ("update" in e) {
      if (seeded.get(table)!.has(e.key)) return;
      const by = made.get(e.key);
      if (by === undefined) problems.push(`${at}: ${table} ${e.key} is not in the task's world, and no earlier event creates it`);
      else if (by !== after) problems.push(`${at}: ${table} ${e.key} is created by an event after ${by}, which may not have fired yet after ${after}: update it in an event after the same call, or seed it with given.rows`);
      return;
    }
    const key = e.values[seed.tables[table]!.key];
    if (key === undefined) return;
    if (seeded.get(table)!.has(String(key)) || made.has(String(key))) problems.push(`${at}: ${table} ${String(key)} already exists`);
    else made.set(String(key), after);
  });
  return problems;
}

/** What's wrong with a task's `given`: rows for a table the world doesn't have or without its key, or nothing given at all. */
function givenProblems(d: Domain, given: Given, where: string, tables: Set<string>): string[] {
  const problems: string[] = [];
  const rows = Object.entries(given.rows ?? {});
  if (!rows.some(([, r]) => r.length) && !Object.keys(given.context ?? {}).length) {
    problems.push(`${where}: gives nothing: add rows or context, or remove it`);
  }
  for (const [name, list] of rows) {
    if (!tables.has(name)) {
      problems.push(`${where}.rows: unknown table "${name}"`);
      continue;
    }
    const key = d.world.tables[name]!.key;
    const keys = new Set<string>();
    list.forEach((row, i) => {
      const k = row[key];
      if (k === undefined) problems.push(`${where}.rows.${name}[${i}]: missing key field "${key}"`);
      else if (keys.has(String(k))) problems.push(`${where}.rows.${name}: duplicate key ${String(k)}`);
      else keys.add(String(k));
    });
  }
  return problems;
}

/**
 * Why a never_disclose field can't be found in what the agent says, judged from the seed rows:
 * the transcript check looks only for numbers and strings of 3 or more characters. A table
 * without seed rows, or rows without the field, can't be judged (tools may create the values).
 */
/** Every argument reference in a tool's op or check, read exactly as resolve() reads it at run time. */
function references(value: unknown): { ref: string; name: string; path: string[] }[] {
  if (typeof value === "string") {
    const found: { ref: string; name: string; path: string[] }[] = [];
    substitute(value, (name, ref, path) => found.push({ ref, name, path }));
    return found;
  }
  if (Array.isArray(value)) return value.flatMap(references);
  if (value && typeof value === "object") return Object.values(value).flatMap(references);
  return [];
}

type Param = Tool["params"][string];

/**
 * The param a dotted name reaches: a top-level param by its own name first, then a path through an object's
 * properties and an array's items, where a segment into an array is an index.
 */
function paramAt(params: Record<string, Param>, name: string): Param | undefined {
  if (Object.hasOwn(params, name)) return params[name];
  const [root, ...path] = name.split(".");
  let p = Object.hasOwn(params, root!) ? params[root!] : undefined;
  for (const seg of path) {
    if (p?.type === "object" && p.properties && Object.hasOwn(p.properties, seg)) p = p.properties[seg];
    else if (p?.type === "array" && /^\d+$/.test(seg)) p = p.items;
    else return undefined;
  }
  return p;
}

/**
 * What's wrong with a param's default, and its fields' defaults: a `null` needs `nullable`, a list or an object
 * suits only an array or object param, and an object or array param's default must be a valid argument. A scalar
 * param's string, number or boolean default is used as written, as before params could nest.
 */
function defaultProblems(p: Param, where: string): string[] {
  const problems: string[] = [];
  const d = p.default;
  const scalar = p.type !== "object" && p.type !== "array";
  if (d === null && !p.nullable) problems.push(`${where}.default: null needs nullable: true`);
  else if (d !== undefined && d !== null && scalar && typeof d === "object") problems.push(`${where}.default: a ${p.type} param can't default to ${Array.isArray(d) ? "a list" : "an object"}`);
  else if (d !== undefined && d !== null && !scalar) {
    const coerced = coerceArgs({ params: { default: { ...p, default: undefined, required: true } } } as unknown as Tool, { default: d });
    if ("error" in coerced) problems.push(`${where}.default: ${coerced.error.replace(/"default(?=[.\[" ])/, `"${where.split(".").at(-1)}`)}`);
  }
  for (const [name, child] of Object.entries(p.properties ?? {})) problems.push(...defaultProblems(child, `${where}.properties.${name}`));
  if (p.items) problems.push(...defaultProblems(p.items, `${where}.items`));
  return problems;
}

function undetectable(d: Domain, table: string, field: string): string | undefined {
  const values = (d.world.tables[table]?.rows ?? []).map((r) => r[field]).filter((v) => v !== undefined && v !== null);
  const fix = "protect a field that holds numbers or longer text, or remove the invariant and keep the rule as a comment";
  if (values.some((v) => typeof v === "boolean")) {
    return `it holds booleans, and only numbers and strings of 3 or more characters can be found in what the agent says; ${fix}`;
  }
  if (values.length && values.every((v) => typeof v === "string" && v.trim().length < 3)) {
    return `every seeded value is shorter than 3 characters, and shorter strings are not checked; ${fix}`;
  }
  return undefined;
}

/**
 * What `validate` warns about: likely mistakes that still leave a valid domain. A `never_disclose` value counts
 * only once the agent has been shown it, so a field that no tool returns and sandtable's default system prompt
 * doesn't state, for any task, can never fire. A custom agent may learn it another way, so this is a warning, not an error.
 */
export function domainWarnings(d: Domain): string[] {
  const warnings: string[] = [];
  // The default prompt, and each task's prompt that states a `given.context`.
  const prompts = [agentSystemPrompt(d), ...d.tasks.filter((t) => taskContext(t)).map((t) => agentSystemPrompt(d, t))];
  for (const inv of d.invariants) {
    if (!("never_disclose" in inv)) continue;
    const { table, field } = inv.never_disclose;
    if (undetectable(d, table, field) || d.tools.some((t) => returnsTable(t, table))) continue;
    const values = protectedValues(d.world.tables[table]?.rows ?? [], field);
    if ([...values].some((v) => prompts.some((p) => mentions(p, v)))) continue;
    warnings.push(
      `invariants.${inv.id}: never_disclose on ${table}.${field} can never fail a trial: no tool returns a ${table} record and the policy states none of its values, ` +
        `so the agent is never shown one. Return ${table} from a tool, or state the value in the policy if your agent's own prompt holds it.`,
    );
  }
  return warnings;
}

/** Whether a tool's result, the op at `returns`, holds records of `table`. */
function returnsTable(t: Tool, table: string): boolean {
  const op = t.ops[Math.min(t.returns, t.ops.length - 1)]!;
  const target = "get" in op ? op.get : "list" in op ? op.list : "create" in op ? op.create : "update" in op ? op.update : undefined;
  return target === table;
}

export interface PendingItem {
  kind: "tool" | "invariant" | "task";
  id: string;
  source?: { file: string; quote?: string };
}

/** Drafted items nobody has accepted yet. Results that depend on them are provisional. */
export function pendingReview(d: Domain): PendingItem[] {
  return [
    ...d.tools.filter((t) => t.review === "pending").map((t) => ({ kind: "tool" as const, id: t.name })),
    ...d.invariants.filter((i) => i.review === "pending").map((i) => ({ kind: "invariant" as const, id: i.id, source: i.source })),
    ...d.tasks.filter((t) => t.review === "pending").map((t) => ({ kind: "task" as const, id: t.id, source: t.source })),
  ];
}

/** One token ending in .md, .yaml or .yml: a path, so a missing file is an error rather than inline text. */
const PATH = /^\S+\.(md|ya?ml)$/i;

function parseYaml(text: string, file: string): unknown {
  try {
    return YAML.parse(text);
  } catch (err) {
    throw new DomainError(`${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function isDir(p: string): Promise<boolean> {
  return (await stat(p).catch(() => undefined))?.isDirectory() ?? false;
}

async function exists(p: string): Promise<boolean> {
  return (await stat(p).catch(() => undefined)) !== undefined;
}
