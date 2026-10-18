import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { DomainSpec, type Domain } from "./schema.ts";

export const DOMAIN_FILE = "rehearsal.yaml";

export class DomainError extends Error {}

/**
 * Load a domain from a directory containing rehearsal.yaml (or the file itself).
 * Any top-level value that is a relative path to an existing .md/.yaml/.yml file is inlined,
 * so policy, world and tasks can live in their own files.
 */
export async function loadDomain(target: string): Promise<Domain> {
  const file = (await isDir(target)) ? path.join(target, DOMAIN_FILE) : target;
  const dir = path.dirname(file);
  const raw = YAML.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  if (!raw || typeof raw !== "object") throw new DomainError(`${file} is empty or not a YAML mapping`);

  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string" || !/\.(md|ya?ml)$/i.test(value)) continue;
    const included = path.resolve(dir, value);
    if (!(await exists(included))) continue;
    const text = await readFile(included, "utf8");
    raw[key] = included.endsWith(".md") ? text : YAML.parse(text);
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
    if (t && !(name in t.params)) problems.push(`${where}: tool "${toolName}" has no param "${name}"`);
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
      for (const ref of [inv.limit.lte, inv.limit.gte]) {
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
    for (const name of [...task.expect.called, ...task.expect.not_called]) tool(name, `${where}.expect`);
  }
  return problems;
}

async function isDir(p: string): Promise<boolean> {
  return (await stat(p).catch(() => undefined))?.isDirectory() ?? false;
}

async function exists(p: string): Promise<boolean> {
  return (await stat(p).catch(() => undefined)) !== undefined;
}
