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

type Param = Tool["params"][string];

export function toolSchema(tool: Tool): ToolSchema {
  const { properties, required } = objectSchema(tool.params);
  return {
    name: tool.name,
    description: tool.description,
    input_schema: { type: "object", properties, required, additionalProperties: false },
  };
}

function objectSchema(params: Record<string, Param>): { properties: Record<string, Record<string, unknown>>; required: string[] } {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const [name, p] of Object.entries(params)) {
    properties[name] = paramSchema(p);
    if (p.required) required.push(name);
  }
  return { properties, required };
}

/** One param as JSON Schema. A scalar's keys come in the order they always have, so existing tool schemas don't change. */
function paramSchema(p: Param): Record<string, unknown> {
  const nested =
    p.type === "object" ? { ...objectSchema(p.properties ?? {}), additionalProperties: false } : p.type === "array" ? { items: paramSchema(p.items!) } : {};
  return {
    type: p.nullable ? [p.type, "null"] : p.type,
    ...(p.description ? { description: p.description } : {}),
    ...nested,
    ...(p.enum ? { enum: p.enum } : {}),
    ...(p.default !== undefined ? { default: p.default } : {}),
  };
}

/**
 * Validate and coerce raw model arguments against the tool's params.
 * Lenient on representation ("2,100" -> 2100, 100101 -> "100101", an object sent as a JSON string), strict on
 * names and presence, because hallucinated or missing arguments are exactly what a rehearsal should surface.
 * Errors name the argument's path, such as `items[1].qty`.
 */
export function coerceArgs(tool: Tool, raw: unknown): { args: Args } | { error: string } {
  if (raw === undefined || raw === null) raw = {};
  if (!isPlainObject(raw)) return { error: "arguments must be a JSON object" };
  const out = coerceObject(tool.params, raw, "");
  return "error" in out ? out : { args: out.value };
}

type Coerced<T> = { value: T } | { error: string };

/** The fields of an object against its params: unknown names, then each param in order. */
function coerceObject(params: Record<string, Param>, raw: Record<string, unknown>, prefix: string): Coerced<Args> {
  const out: Args = {};
  // Own keys only, on both sides: `in` and a bare lookup would also find Object.prototype members
  // such as toString or constructor.
  for (const name of Object.keys(raw)) {
    if (!Object.hasOwn(params, name)) return { error: `unknown argument "${prefix}${name}"` };
  }
  for (const [name, p] of Object.entries(params)) {
    const value = Object.hasOwn(raw, name) ? raw[name] : undefined;
    const path = `${prefix}${name}`;
    if (value === null && p.nullable) {
      out[name] = null;
      continue;
    }
    if (value === undefined || value === null || value === "") {
      // A model that means "none" may leave a nullable argument out, or send "": say null is the way.
      if (p.required) return { error: `missing required argument "${path}"${p.nullable ? " (it may be null)" : ""}` };
      if (p.default !== undefined) out[name] = p.default;
      continue;
    }
    const coerced = coerceValue(value, p, path);
    if ("error" in coerced) return coerced;
    out[name] = coerced.value;
  }
  return { value: out };
}

function coerceValue(value: unknown, p: Param, path: string): Coerced<unknown> {
  if (p.type === "object") {
    const obj = typeof value === "string" ? parsedJson(value) : value;
    if (!isPlainObject(obj)) return { error: `argument "${path}" must be an object` };
    return coerceObject(p.properties ?? {}, obj, `${path}.`);
  }
  if (p.type === "array") {
    const list = typeof value === "string" ? parsedJson(value) : value;
    if (!Array.isArray(list)) return { error: `argument "${path}" must be an array` };
    const items = p.items!;
    const out: unknown[] = [];
    for (const [i, item] of list.entries()) {
      if (item === null && items.nullable) {
        out.push(null);
        continue;
      }
      const at = `${path}[${i}]`;
      if (item === undefined || item === null || item === "") return { error: `argument "${at}" is missing` };
      const coerced = coerceValue(item, items, at);
      if ("error" in coerced) return coerced;
      out.push(coerced.value);
    }
    return { value: out };
  }
  const coerced = coerce(value, p.type);
  if (coerced === undefined) return { error: `argument "${path}" must be ${p.type === "integer" ? "an" : "a"} ${p.type}` };
  if (p.enum && !p.enum.some((e) => e === coerced)) return { error: `argument "${path}" must be one of ${p.enum.join(", ")}` };
  return { value: coerced };
}

/** A JSON string's value, or undefined when it isn't JSON: models sometimes send an object or a list as text. */
function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
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
    const key = resolve(check.key, args, tool.params);
    if (key === undefined || key === "") continue;
    const row = world.get(check.table, String(key));
    const where = check.where ? (resolve(check.where, args, tool.params) as Row) : undefined;
    if (!row || (where && !matches(row, where))) {
      return { ok: false, error: String(resolve(check.error, args, tool.params)) };
    }
  }
  const before = world.snapshot();
  try {
    const results = tool.ops.map((op) => runOp(op, world, args, tool));
    return { ok: true, result: results[Math.min(tool.returns, results.length - 1)] };
  } catch (err) {
    world.restore(before);
    if (err instanceof WorldError) return { ok: false, error: err.message };
    throw err;
  }
}

function runOp(op: Op, world: World, args: Args, tool: Tool): unknown {
  if ("get" in op) {
    const key = String(resolve(op.key, args, tool.params));
    const row = world.get(op.get, key);
    if (!row) throw new WorldError(`${op.get} ${key} not found`);
    return row;
  }
  if ("list" in op) return world.list(op.list, op.where ? (resolve(op.where, args, tool.params) as Row) : {}, op.limit);
  if ("create" in op) return world.insert(op.create, resolve(op.values, args, tool.params) as Row);
  if ("update" in op) return world.update(op.update, String(resolve(op.key, args, tool.params)), resolve(op.set, args, tool.params) as Row);
  return resolve(op.respond, args, tool.params);
}

