import type { Op, Tool } from "../spec/schema.ts";
import { isPlainObject, matches, resolve, type Args, type Row } from "./match.ts";
import { World, WorldError } from "./store.ts";

export interface ToolOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** JSON-schema tool definition, in the shape most model APIs accept. */
export interface ToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: false;
  };
}

export function toolSchema(tool: Tool): ToolSchema {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const [name, p] of Object.entries(tool.params)) {
    properties[name] = {
      type: p.type,
      ...(p.description ? { description: p.description } : {}),
      ...(p.enum ? { enum: p.enum } : {}),
      ...(p.default !== undefined ? { default: p.default } : {}),
    };
    if (p.required) required.push(name);
  }
  return {
    name: tool.name,
    description: tool.description,
    input_schema: { type: "object", properties, required, additionalProperties: false },
  };
}

/**
 * Validate and coerce raw model arguments against the tool's params.
 * Lenient on representation ("2,100" -> 2100, 100101 -> "100101"), strict on names and presence,
 * because hallucinated or missing arguments are exactly what a rehearsal should surface.
 */
export function coerceArgs(tool: Tool, raw: unknown): { args: Args } | { error: string } {
  if (raw === undefined || raw === null) raw = {};
  if (!isPlainObject(raw)) return { error: "arguments must be a JSON object" };
  const args: Args = {};
  // Own keys only, on both sides: `in` and a bare lookup would also find Object.prototype members
  // such as toString or constructor.
  for (const name of Object.keys(raw)) {
    if (!Object.hasOwn(tool.params, name)) return { error: `unknown argument "${name}"` };
  }
  for (const [name, p] of Object.entries(tool.params)) {
    const value = Object.hasOwn(raw, name) ? raw[name] : undefined;
    if (value === undefined || value === null || value === "") {
      if (p.required) return { error: `missing required argument "${name}"` };
      if (p.default !== undefined) args[name] = p.default;
      continue;
    }
    const coerced = coerce(value, p.type);
    if (coerced === undefined) return { error: `argument "${name}" must be a ${p.type}` };
    if (p.enum && !p.enum.some((e) => e === coerced)) {
      return { error: `argument "${name}" must be one of ${p.enum.join(", ")}` };
    }
    args[name] = coerced;
  }
  return { args };
}

function coerce(value: unknown, type: "string" | "number" | "integer" | "boolean"): unknown {
  switch (type) {
    case "string":
      return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
    case "number":
    case "integer": {
      const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/[$,\s]/g, "")) : NaN;
      if (!Number.isFinite(n)) return undefined;
      return type === "integer" && !Number.isInteger(n) ? undefined : n;
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      if (value === "true" || value === "false") return value === "true";
      return undefined;
  }
}

/** Run a tool against the world. Checks run first; ops are atomic (all or nothing). */
export function executeTool(tool: Tool, world: World, args: Args): ToolOutcome {
  for (const check of tool.checks) {
    const key = resolve(check.key, args);
    if (key === undefined || key === "") continue;
    const row = world.get(check.table, String(key));
    const where = check.where ? (resolve(check.where, args) as Row) : undefined;
    if (!row || (where && !matches(row, where))) {
      return { ok: false, error: String(resolve(check.error, args)) };
    }
  }
  const before = world.snapshot();
  try {
    const results = tool.ops.map((op) => runOp(op, world, args));
    return { ok: true, result: results[Math.min(tool.returns, results.length - 1)] };
  } catch (err) {
    world.restore(before);
    if (err instanceof WorldError) return { ok: false, error: err.message };
    throw err;
  }
}

function runOp(op: Op, world: World, args: Args): unknown {
  if ("get" in op) {
    const key = String(resolve(op.key, args));
    const row = world.get(op.get, key);
    if (!row) throw new WorldError(`${op.get} ${key} not found`);
    return row;
  }
  if ("list" in op) return world.list(op.list, op.where ? (resolve(op.where, args) as Row) : {}, op.limit);
  if ("create" in op) return world.insert(op.create, resolve(op.values, args) as Row);
  if ("update" in op) return world.update(op.update, String(resolve(op.key, args)), resolve(op.set, args) as Row);
  return resolve(op.respond, args);
}

