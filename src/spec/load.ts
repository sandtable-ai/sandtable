import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { expectedTool } from "../grade/expectations.ts";
import { mentions, protectedValues } from "../grade/invariants.ts";
import { agentSystemPrompt } from "../sim/prompts.ts";
import { operatorProblems, substitute } from "../world/match.ts";
import { DomainSpec, type Domain, type Tool } from "./schema.ts";

export const DOMAIN_FILE = "sandtable.yaml";

export class DomainError extends Error {}

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
    throw new DomainError(`no ${DOMAIN_FILE} found at ${target} (create one, or draft it with \`npx sandtable-ai init\`)`);
  });
  const raw = parseYaml(text, file) as Record<string, unknown>;
  if (!raw || typeof raw !== "object") throw new DomainError(`${file} is empty or not a YAML mapping`);

  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string" || !/\.(md|ya?ml)$/i.test(value.trim())) continue;
    const included = path.resolve(dir, value.trim());
    if (!(await exists(included))) {
      if (PATH.test(value.trim())) throw new DomainError(`${file}: ${key}: ${value.trim()} not found (looked for ${included})`);
      continue;
    }
    const text = await readFile(included, "utf8");
    raw[key] = /\.md$/i.test(included) ? text : parseYaml(text, included);
  }

  const parsed = DomainSpec.safeParse(raw);
  if (!parsed.success) throw new DomainError(`${file}:\n${z.prettifyError(parsed.error)}`);
  const problems = validateDomain(parsed.data);
  if (problems.length) throw new DomainError(`${file}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  return parsed.data;
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
  const arg = (toolName: string, name: string, where: string) => {
    const t = tools.get(toolName);
    // Own keys only: `in` would also find Object.prototype members such as toString or constructor.
    if (t && !Object.hasOwn(t.params, name)) problems.push(`${where}: tool "${toolName}" has no param "${name}"`);
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
    t.checks.forEach((c, i) => table(c.table, `tools.${t.name}.checks[${i}]`));
    t.ops.forEach((op, i) => {
      const name = "get" in op ? op.get : "list" in op ? op.list : "create" in op ? op.create : "update" in op ? op.update : undefined;
      if (name) table(name, `tools.${t.name}.ops[${i}]`);
    });
    const unresolved = (value: unknown, where: string) => {
      for (const { ref, name } of references(value)) {
        if (!Object.hasOwn(t.params, name)) problems.push(`${where}: "${ref}" never resolves: tool "${t.name}" has no param "${name}"`);
      }
    };
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
    }
  }

  const personas = new Set(d.personas.map((p) => p.id));
  const taskIds = new Set<string>();
  for (const task of d.tasks) {
    const where = `tasks.${task.id}`;
    if (taskIds.has(task.id)) problems.push(`${where}: duplicate task id`);
    taskIds.add(task.id);
    if (task.persona && !personas.has(task.persona)) problems.push(`${where}: unknown persona "${task.persona}"`);
    task.expect.state.forEach((a, i) => table(a.table, `${where}.expect.state[${i}]`));
    task.reference?.forEach((c, i) => tool(c.tool, `${where}.reference[${i}]`));
    for (const list of ["called", "not_called"] as const) {
      task.expect[list].forEach((e, i) => {
        tool(expectedTool(e), `${where}.expect`);
        if (typeof e === "string") return;
        for (const name of Object.keys(e.args)) arg(e.tool, name, `${where}.expect.${list}[${i}]`);
        for (const p of operatorProblems(e.args)) problems.push(`${where}.expect.${list}[${i}].args.${p}`);
      });
    }
  }
  return problems;
}

/**
 * Why a never_disclose field can't be found in what the agent says, judged from the seed rows:
 * the transcript check looks only for numbers and strings of 3 or more characters. A table
 * without seed rows, or rows without the field, can't be judged (tools may create the values).
 */
/** Every argument reference in a tool's op or check, read exactly as resolve() reads it at run time. */
function references(value: unknown): { ref: string; name: string }[] {
  if (typeof value === "string") {
    const found: { ref: string; name: string }[] = [];
    substitute(value, (name, ref) => found.push({ ref, name }));
    return found;
  }
  if (Array.isArray(value)) return value.flatMap(references);
  if (value && typeof value === "object") return Object.values(value).flatMap(references);
  return [];
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
 * doesn't state can never fire. A custom agent may learn it another way, so this is a warning, not an error.
 */
export function domainWarnings(d: Domain): string[] {
  const warnings: string[] = [];
  const prompt = agentSystemPrompt(d);
  for (const inv of d.invariants) {
    if (!("never_disclose" in inv)) continue;
    const { table, field } = inv.never_disclose;
    if (undetectable(d, table, field) || d.tools.some((t) => returnsTable(t, table))) continue;
    const values = protectedValues(d.world.tables[table]?.rows ?? [], field);
    if ([...values].some((v) => mentions(prompt, v))) continue;
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
