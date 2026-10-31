/**
 * Deterministic first pass of `sandtable init`: OpenAPI 3.x -> draft world tables and tools.
 * No model involved. Anything the spec cannot tell us (business side effects, conflict
 * conditions, seed data) becomes a review note instead of a guess.
 */

import { isParamName } from "../world/match.ts";

type Json = Record<string, unknown>;

export interface DraftParam {
  type: "string" | "number" | "integer" | "boolean" | "object" | "array";
  description?: string;
  required: boolean;
  enum?: (string | number)[];
  default?: string | number | boolean;
  /** An object's fields. */
  properties?: Record<string, DraftParam>;
  /** An array's element. */
  items?: DraftParam;
}

/** How deep a body field's objects and arrays are drafted as nested params; anything deeper is left out. */
const MAX_DEPTH = 3;

export interface DraftTool {
  name: string;
  description: string;
  params: Record<string, DraftParam>;
  checks: { table: string; key: string; error: string }[];
  ops: Json[];
  returns?: number;
  /** The operation's route, with each path placeholder named as the tool's param, for `run --serve`. */
  http?: { method: string; path: string };
  /** Review notes rendered as comments above the tool. */
  notes: string[];
}

export interface DraftTable {
  key: string;
  rows: Json[];
  /** Field names seen in schemas, for the reviewer (tables themselves are schemaless). */
  fields: string[];
}

export interface OpenApiDraft {
  name: string;
  description: string;
  tables: Record<string, DraftTable>;
  tools: DraftTool[];
  warnings: string[];
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
const PAGINATION = new Set(["limit", "offset", "page", "per_page", "page_size", "cursor", "after", "before", "sort", "order"]);
const SIDE_EFFECT_HINT = /\b(becomes?|marks?|sets?|tenders?|reserves?|cancels?|updates?|changes?|transitions?)\b/i;
const LISTENER_TAG = /\b(notification listeners?|events? subscriptions?)\b/i;
const EVENT_NAME = /^[^{}]+(Event|[_-]event)$/;

/**
 * Why `spec` can't be drafted from, or undefined when it is an OpenAPI 3.x document with paths.
 * Swagger 2.0 and other YAML would otherwise draft an empty domain that fails validation.
 */
export function openApiProblem(spec: unknown): string | undefined {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return "is not an OpenAPI document (expected a YAML or JSON mapping)";
  const s = spec as Json;
  if (s.swagger !== undefined) {
    return `is Swagger ${String(s.swagger)}; init reads OpenAPI 3.x. Convert it to OpenAPI 3 first (for example with the Swagger Editor or swagger2openapi), then run init again`;
  }
  // An unquoted `openapi: 3.0` is a YAML number, and hand-written specs use it.
  const version = typeof s.openapi === "string" || typeof s.openapi === "number" ? String(s.openapi) : undefined;
  if (!version || !/^3(\.|$)/.test(version)) {
    return s.openapi === undefined ? "is not an OpenAPI 3.x document (no top-level `openapi: 3.x` field)" : `is OpenAPI ${String(s.openapi)}; init reads OpenAPI 3.x`;
  }
  if (!s.paths || typeof s.paths !== "object" || Object.keys(s.paths).length === 0) return "has no paths, so there is nothing to draft tools from";
  return undefined;
}

export function draftFromOpenApi(spec: Json): OpenApiDraft {
  const warnings: string[] = [];
  const deref = makeDeref(spec);
  const info = (spec.info ?? {}) as Json;
  const title = typeof info.title === "string" ? info.title : "api";
  const paths = (spec.paths ?? {}) as Record<string, Json>;

  interface TableAcc { key?: string; fields: Map<string, Json>; rows: Json[] }
  const tables = new Map<string, TableAcc>();
  const table = (name: string) => {
    let t = tables.get(name);
    if (!t) tables.set(name, (t = { fields: new Map(), rows: [] }));
    return t;
  };

  interface OpInfo { path: string; method: (typeof METHODS)[number]; op: Json; table: string; itemKey?: string; parents: string[]; action?: string; params: Json[] }
  const ops: OpInfo[] = [];

  for (const [p, item] of Object.entries(paths)) {
    const segments = p.split("/").filter(Boolean);
    const listener = listenerEvidence(segments, item, paths, deref);
    if (listener) {
      warnings.push(`${p}: a webhook listener or event subscription (${listener}), not a resource; skipped`);
      continue;
    }
    const shape = classify(segments, item);
    if (!shape) {
      warnings.push(`${p}: could not find a resource segment; skipped`);
      continue;
    }
    const acc = table(shape.table);
    if (shape.itemKey) acc.key ??= shape.itemKey;
    const pathParams = (item.parameters as Json[] | undefined) ?? [];
    for (const method of METHODS) {
      const op = item[method] as Json | undefined;
      if (!op) continue;
      const params = [...pathParams, ...((op.parameters as Json[] | undefined) ?? [])].map((x) => deref(x) as Json);
      ops.push({ path: p, method, op, ...shape, params });
      for (const [name, callback] of Object.entries((op.callbacks ?? {}) as Json)) {
        for (const url of Object.keys((deref(callback) ?? {}) as Json)) {
          warnings.push(`${method.toUpperCase()} ${p}: callback "${name}" (${url}), a request the API sends to the client; skipped`);
        }
      }
      for (const media of responseMedia(op, deref)) {
        if (media.schema) collectFields(acc, media.schema as Json, deref);
        acc.rows.push(...mediaExamples(media, deref));
      }
      const body = requestSchema(op, deref);
      if (body && !shape.action) collectFields(acc, body, deref, false);
    }
  }
  for (const name of Object.keys((spec.webhooks ?? {}) as Json)) {
    warnings.push(`webhooks.${name}: an OpenAPI webhook, a request the API sends to the client; skipped`);
  }

  for (const [name, t] of tables) {
    if (t.key) continue;
    const singular = singularize(name);
    t.key = [`${singular}_id`, "id", `${singular}Id`].find((k) => t.fields.has(k)) ?? `${singular}_id`;
  }
  const keyOwners = new Map<string, string>();
  for (const [name, t] of tables) keyOwners.set(t.key!, name);

  const tools: DraftTool[] = [];
  const names = new Set<string>();
  for (const o of ops) {
    const where = `${o.method.toUpperCase()} ${o.path}`;
    const tool: DraftTool = {
      name: uniqueName(names, snake(String(o.op.operationId ?? `${o.method}_${o.action ?? o.table}`))),
      description: describe(o.op, where),
      params: {},
      checks: [],
      ops: [],
      notes: [],
    };

    // The tool's inputs by their name in the spec: path and query params, then body fields.
    const inputs = new Map<string, { param: DraftParam; loc: string }>();
    for (const p of o.params) {
      const name = String(p.name);
      const loc = String(p.in);
      if (loc !== "path" && loc !== "query") {
        warnings.push(`${where}: ${loc} parameter "${name}" ignored`);
        continue;
      }
      if (loc === "query" && PAGINATION.has(name)) continue;
      // Path and query values are filters on a table, so they stay scalars.
      const param = toParam(deref(p.schema ?? {}) as Json, deref, loc === "path" || p.required === true, p.description, MAX_DEPTH);
      if (!param) {
        warnings.push(`${where}: parameter "${name}" is not a scalar; skipped`);
        continue;
      }
      inputs.set(name, { param, loc }); // an operation's own parameter overrides the path's
    }
    // A path parameter the spec forgot to declare is still a required argument.
    for (const name of pathParams(o.path)) if (!inputs.has(name)) inputs.set(name, { param: { type: "string", required: true }, loc: "path" });

    const bodyFields: string[] = [];
    const body = requestSchema(o.op, deref);
    if (body) {
      const required = new Set((body.required as string[] | undefined) ?? []);
      for (const [name, raw] of Object.entries((body.properties ?? {}) as Json)) {
        const param = toParam(deref(raw) as Json, deref, required.has(name));
        if (!param) {
          warnings.push(`${where}: body field "${name}" has a schema init can't map; skipped`);
          tool.notes.push(`Body field "${name}" was left out: init maps scalars, and objects and arrays of them up to ${MAX_DEPTH} levels deep, not a schema with several types or an array without items. Add it as a param by hand if the agent needs it.`);
          continue;
        }
        if (!inputs.has(name)) inputs.set(name, { param, loc: "body" });
        bodyFields.push(name);
      }
    }

    const renames: string[] = [];
    const paramOf = paramNames([...inputs.keys()], (name, param, taken) => {
      renames.push(`${where}: "${name}" is param "${param}", since "${taken}" is another field's param`);
    });
    const ref = (name: string) => `$${paramOf.get(name)}`;
    const filters: Json = {};
    for (const [name, { param, loc }] of inputs) {
      tool.params[paramOf.get(name)!] = param;
      if (loc === "path" && o.parents.includes(name)) filters[name] = ref(name);
      if (loc === "query") filters[name] = param.type === "string" && !param.enum ? { $contains: ref(name) } : ref(name);
    }

    // The world server keeps these routes for itself, so a tool on one of them gets no http route.
    if (/^\/(?:tools|mcp|webhook|sessions|s)(?:\/|$)/.test(o.path)) {
      warnings.push(`${where}: the world server uses this path for itself, so ${tool.name} gets no http route (call it at /tools/${tool.name})`);
    } else {
      tool.http = { method: o.method.toUpperCase(), path: o.path.replace(/\{([^}]+)\}/g, (_, name: string) => `{${paramOf.get(name) ?? name}}`) };
    }
    const keyRef = o.itemKey ? ref(o.itemKey) : undefined;
    const values = Object.fromEntries([...o.parents, ...bodyFields].map((f) => [f, ref(f)]));
    if (o.action) {
      tool.ops.push({ get: o.table, key: keyRef! });
      tool.notes.push(`"${o.action}" is an action on ${o.table}: replace or extend the get op with update/create ops that model its effect.`);
    } else if (o.method === "get" && o.itemKey) {
      tool.ops.push({ get: o.table, key: keyRef! });
    } else if (o.method === "get") {
      tool.ops.push(Object.keys(filters).length ? { list: o.table, where: filters } : { list: o.table });
    } else if (o.method === "post" && !o.itemKey) {
      tool.ops.push({ create: o.table, values });
    } else if ((o.method === "put" || o.method === "patch") && o.itemKey) {
      tool.ops.push({ update: o.table, key: keyRef!, set: Object.fromEntries(bodyFields.map((f) => [f, ref(f)])) });
    } else {
      warnings.push(`${where}: ${o.method.toUpperCase()} is not supported by the draft; skipped`);
      names.delete(tool.name);
      continue;
    }
    warnings.push(...renames);

    if (o.method !== "get") {
      for (const [name, safe] of paramOf) {
        const owner = keyOwners.get(name);
        if (owner && owner !== o.table) tool.checks.push({ table: owner, key: `$${safe}`, error: `${owner} \${${safe}} not found` });
      }
    }
    for (const [code, raw] of Object.entries((o.op.responses ?? {}) as Json)) {
      if (!/^4(09|22|00|03)$/.test(code)) continue;
      const desc = String((deref(raw) as Json).description ?? "").trim();
      tool.notes.push(`The API can answer ${code}${desc ? ` (${desc})` : ""}: encode that condition as a check with a \`where\`.`);
    }
    const text = `${o.op.summary ?? ""} ${o.op.description ?? ""}`;
    if (o.method !== "get" && SIDE_EFFECT_HINT.test(text)) {
      tool.notes.push(`The description mentions a side effect ("${text.trim()}"): add ops for any other table it changes.`);
    }
    tools.push(tool);
  }

  const outTables: Record<string, DraftTable> = {};
  for (const [name, t] of [...tables].sort(([a], [b]) => a.localeCompare(b))) {
    // One example often answers several operations (a list, GET, POST, PATCH), so a key can repeat.
    // Keep the row with the most fields, which is the fullest example, and say what was dropped.
    const byKey = new Map<string, Json[]>();
    for (const row of t.rows) {
      const key = row[t.key!];
      if (key !== undefined) byKey.set(String(key), [...(byKey.get(String(key)) ?? []), row]);
    }
    const rows = [...byKey].map(([key, same]) => {
      if (same.length > 1) warnings.push(`${name}: ${same.length} examples have ${t.key} "${key}"; kept the one with the most fields and dropped ${same.length - 1}`);
      return same.reduce((kept, row) => (Object.keys(row).length > Object.keys(kept).length ? row : kept));
    });
    outTables[name] = { key: t.key!, rows, fields: [...t.fields.keys()] };
  }
  return {
    name: slug(title),
    description: typeof info.description === "string" && info.description.trim() ? info.description.trim() : title,
    tables: outTables,
    tools,
    warnings,
  };
}

/**
 * Why the path is a webhook listener or an event subscription, or undefined when it is not one.
 * There the client receives the API's events (`POST /listener/<event>`) or registers a URL to
 * receive them (`POST /hub`), so they are not resources an agent acts on. A tag or a name alone
 * is not enough, so that a resource that only sounds like one (`/hubs`, `/listener/restart`,
 * `/events/{id}/subscriptions`) is still drafted. A path is a listener or subscription when:
 * - every operation on it is tagged "notification listener" or "events subscription", and it
 *   takes only POST or DELETE, or its POST takes a callback URL, or
 * - it is `/listener/<event>`, where `<event>` is a name ending in `Event` (or `_event`), and it
 *   takes only POST, or
 * - it is `/hub` or `/hub/{id}`, and `POST /hub` takes a callback URL.
 * A callback URL is a string field named `callback`.
 */
function listenerEvidence(segments: string[], item: Json, paths: Record<string, Json>, deref: (x: unknown) => unknown): string | undefined {
  const methods = METHODS.filter((m) => item[m]);
  if (methods.length === 0) return undefined;
  const tags = methods.map((m) => (((item[m] as Json).tags ?? []) as unknown[]).map(String).find((t) => LISTENER_TAG.test(t)));
  if (tags.every((t) => t !== undefined)) {
    if (methods.every((m) => m === "post" || m === "delete")) return `tagged "${tags[0]}", and only POST or DELETE`;
    if (takesCallbackUrl(item.post, deref)) return `tagged "${tags[0]}", and POST takes a callback URL`;
  }
  const [first, second] = segments;
  if (segments.length === 2 && first === "listener" && EVENT_NAME.test(second!) && methods.every((m) => m === "post")) return "only POST, at /listener/<event>";
  const isHub = first === "hub" && (segments.length === 1 || (segments.length === 2 && /^\{.+\}$/.test(second!)));
  if (isHub && takesCallbackUrl(paths["/hub"]?.post, deref)) return "POST /hub takes a callback URL";
  return undefined;
}

/** Whether `op` has a request body whose `callback` field is a string: the URL a client subscribes. */
function takesCallbackUrl(op: unknown, deref: (x: unknown) => unknown): boolean {
  if (!op || typeof op !== "object") return false;
  const callback = ((requestSchema(op as Json, deref)?.properties ?? {}) as Json).callback;
  return callback !== undefined && flatten(callback, deref).type === "string";
}

/** Work out which table a path addresses, and whether it is an item, a collection or an action. */
function classify(segments: string[], item: Json): { table: string; itemKey?: string; parents: string[]; action?: string } | undefined {
  const isParam = (s: string) => /^\{.+\}$/.test(s);
  const strip = (s: string) => s.slice(1, -1);
  const last = segments.at(-1);
  if (!last) return undefined;
  const literals = segments.filter((s) => !isParam(s));
  if (literals.length === 0) return undefined;

  // /loads/{load_id}/cancel with no GET: an action on the parent resource.
  const prev = segments.at(-2);
  if (!isParam(last) && prev && isParam(prev) && !item.get && segments.length >= 3) {
    const tableSeg = segments.at(-3)!;
    if (!isParam(tableSeg)) {
      return { table: snake(tableSeg), itemKey: strip(prev), parents: paramsBefore(segments, segments.length - 3), action: snake(last) };
    }
  }
  if (isParam(last)) {
    const tableSeg = segments.at(-2);
    if (!tableSeg || isParam(tableSeg)) return undefined;
    return { table: snake(tableSeg), itemKey: strip(last), parents: paramsBefore(segments, segments.length - 2) };
  }
  return { table: snake(last), parents: paramsBefore(segments, segments.length - 1) };

  function paramsBefore(segs: string[], end: number): string[] {
    return segs.slice(0, end).filter(isParam).map(strip);
  }
}

/**
 * A tool param name for each name in the spec, one that a `$name` reference resolves (see
 * `substitute()` in src/world/match.ts). Names that already qualify keep themselves, and are
 * claimed first. Each other name is rewritten (`@type` becomes `at_type`, `pickup-window`
 * becomes `pickup_window`), with `_2`, `_3`… and a call to `onSuffix` when that name is taken.
 */
function paramNames(names: string[], onSuffix: (name: string, param: string, taken: string) => void): Map<string, string> {
  const paramOf = new Map<string, string>();
  for (const name of names) if (isParamName(name)) paramOf.set(name, name);
  const taken = new Set(paramOf.values());
  for (const name of names) {
    if (paramOf.has(name)) continue;
    let base = name.replace(/^@/, "at_").replace(/\W+/g, "_").replace(/_+$/, "") || "param";
    if (/^\d/.test(base)) base = `_${base}`;
    let param = base;
    for (let i = 2; taken.has(param); i++) param = `${base}_${i}`;
    if (param !== base) onSuffix(name, param, base);
    paramOf.set(name, param);
    taken.add(param);
  }
  return paramOf;
}

function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
}

/**
 * A tool param for a schema, or undefined when it can't be one. An object's properties and an array's items
 * are mapped too, until `depth` reaches MAX_DEPTH, so a `$ref` cycle ends there.
 */
export function toParam(schema: Json, deref: (x: unknown) => unknown, required: boolean, description?: unknown, depth = 0): DraftParam | undefined {
  const s = flatten(schema, deref);
  const desc = (description ?? s.description) as string | undefined;
  if (s.type === "object" || (s.type === undefined && s.properties)) {
    if (depth >= MAX_DEPTH || !s.properties || typeof s.properties !== "object") return undefined;
    const needed = new Set((s.required as string[] | undefined) ?? []);
    const properties: Record<string, DraftParam> = {};
    for (const [name, raw] of Object.entries(s.properties as Json)) {
      const child = toParam(deref(raw) as Json, deref, needed.has(name), undefined, depth + 1);
      if (!child) return undefined;
      properties[name] = child;
    }
    if (!Object.keys(properties).length) return undefined;
    return { type: "object", required, ...(desc ? { description: String(desc).trim() } : {}), properties };
  }
  if (s.type === "array") {
    if (depth >= MAX_DEPTH || !s.items) return undefined;
    const items = toParam(deref(s.items) as Json, deref, true, undefined, depth + 1);
    if (!items) return undefined;
    return { type: "array", required, ...(desc ? { description: String(desc).trim() } : {}), items };
  }
  // A nullable enum lists null among its values: an agent can't pass it, so the param's enum leaves it out.
  const values = Array.isArray(s.enum) ? (s.enum.filter((v) => v !== null) as (string | number)[]) : undefined;
  let type = s.type as string | undefined;
  if (!type && values) type = typeof values[0] === "number" ? "number" : "string";
  if (!type) type = "string";
  if (!["string", "number", "integer", "boolean"].includes(type)) return undefined;
  const param: DraftParam = { type: type as DraftParam["type"], required };
  if (desc) param.description = String(desc).trim();
  if (values?.length) param.enum = values;
  if (!required && ["string", "number", "boolean"].includes(typeof s.default)) param.default = s.default as string | number | boolean;
  return param;
}

function collectFields(acc: { fields: Map<string, Json>; rows: Json[] }, node: Json, deref: (x: unknown) => unknown, withExamples = true) {
  const schema = flatten(node, deref);
  const s = schema.type === "array" ? flatten(schema.items, deref) : schema;
  for (const [name, raw] of Object.entries((s.properties ?? {}) as Json)) acc.fields.set(name, deref(raw) as Json);
  if (!withExamples) return;
  const examples = schema.type === "array" && Array.isArray(schema.example) ? schema.example : s.example ? [s.example] : [];
  acc.rows.push(...examples.filter(isRow));
}

/** The media type object of each 2xx response, JSON when there is a choice. */
function responseMedia(op: Json, deref: (x: unknown) => unknown): Json[] {
  const out: Json[] = [];
  for (const [code, raw] of Object.entries((op.responses ?? {}) as Json)) {
    if (!/^2\d\d$/.test(code)) continue;
    const content = ((deref(raw) as Json).content ?? {}) as Json;
    const media = (content["application/json"] ?? Object.values(content)[0]) as Json | undefined;
    if (media) out.push(media);
  }
  return out;
}

/**
 * Rows from a media type's own `example` and from the `value` of each entry in its `examples`
 * map, read as a schema's `example` is: an object is a row, an array is a list of rows.
 */
function mediaExamples(media: Json, deref: (x: unknown) => unknown): Json[] {
  const named = Object.values((media.examples ?? {}) as Json).map((ex) => (deref(ex) as Json | undefined)?.value);
  return [media.example, ...named].flatMap((value) => (Array.isArray(value) ? value : [value])).filter(isRow);
}

function isRow(x: unknown): x is Json {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function requestSchema(op: Json, deref: (x: unknown) => unknown): Json | undefined {
  const body = deref(op.requestBody) as Json | undefined;
  const content = (body?.content ?? {}) as Json;
  const media = (content["application/json"] ?? Object.values(content)[0]) as Json | undefined;
  const schema = media?.schema ? flatten(media.schema, deref) : undefined;
  return schema && (schema.type === "object" || schema.properties) ? schema : undefined;
}

/**
 * `node` dereferenced, with its `allOf` members (themselves flattened) merged in: their
 * properties are combined, their required lists joined, and the schema's own keywords win over
 * theirs. A member's `example` is left out, since it shows that member alone, not the whole object.
 * An OpenAPI 3.1 nullable type (`type: [string, "null"]`) reads as its one other type, as 3.0's
 * `nullable: true` does; a type array with two other types, or none, is left as it is.
 */
function flatten(node: unknown, deref: (x: unknown) => unknown, depth = 0): Json {
  const schema = deref(node);
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return {};
  const { allOf, ...own } = schema as Json;
  if (Array.isArray(own.type)) {
    const types = own.type.filter((t) => t !== "null");
    if (types.length === 1) own.type = types[0];
  }
  if (!Array.isArray(allOf) || depth > 20) return own;
  const parts = allOf.map((member) => {
    const { example: _, ...rest } = flatten(member, deref, depth + 1);
    return rest;
  });
  parts.push(own);
  const merged: Json = Object.assign({}, ...parts);
  const properties = Object.assign({}, ...parts.map((p) => p.properties ?? {})) as Json;
  const required = [...new Set(parts.flatMap((p) => (Array.isArray(p.required) ? (p.required as string[]) : [])))];
  if (Object.keys(properties).length) merged.properties = properties;
  if (required.length) merged.required = required;
  return merged;
}

function makeDeref(spec: Json) {
  const deref = (node: unknown, depth = 0): unknown => {
    if (!node || typeof node !== "object" || depth > 20) return node;
    const ref = (node as Json).$ref;
    if (typeof ref !== "string") return node;
    if (!ref.startsWith("#/")) return {};
    const target = ref
      .slice(2)
      .split("/")
      .reduce<unknown>((cur, key) => (cur && typeof cur === "object" ? (cur as Json)[key.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined), spec);
    return deref(target, depth + 1);
  };
  return deref;
}

function describe(op: Json, where: string): string {
  const parts = [op.summary, op.description].filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
  return parts.length ? parts.join(". ").replace(/\.\./g, ".") : `${where} (no description in the spec: write one for the model)`;
}

export function snake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

export function slug(s: string): string {
  return snake(s).replace(/_/g, "-") || "domain";
}

export function singularize(s: string): string {
  if (s.endsWith("ies")) return `${s.slice(0, -3)}y`;
  if (s.endsWith("sses") || s.endsWith("xes") || s.endsWith("ches") || s.endsWith("shes")) return s.slice(0, -2);
  if (s.endsWith("s") && !s.endsWith("ss") && !s.endsWith("us")) return s.slice(0, -1);
  return s;
}

export function uniqueName(seen: Set<string>, base: string): string {
  let name = base.slice(0, 64) || "tool";
  for (let i = 2; seen.has(name); i++) name = `${base.slice(0, 60)}_${i}`;
  seen.add(name);
  return name;
}
