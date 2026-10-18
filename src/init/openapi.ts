/**
 * Deterministic first pass of `sandtable init`: OpenAPI 3.x -> draft world tables and tools.
 * No model involved. Anything the spec cannot tell us (business side effects, conflict
 * conditions, seed data) becomes a review note instead of a guess.
 */

type Json = Record<string, unknown>;

export interface DraftParam {
  type: "string" | "number" | "integer" | "boolean";
  description?: string;
  required: boolean;
  enum?: (string | number)[];
  default?: string | number | boolean;
}

export interface DraftTool {
  name: string;
  description: string;
  params: Record<string, DraftParam>;
  checks: { table: string; key: string; error: string }[];
  ops: Json[];
  returns?: number;
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
      for (const schema of responseSchemas(op, deref)) collectFields(acc, schema, deref);
      const body = requestSchema(op, deref);
      if (body && !shape.action) collectFields(acc, body, deref, false);
    }
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

    const filters: Json = {};
    for (const p of o.params) {
      const name = String(p.name);
      const loc = String(p.in);
      if (loc !== "path" && loc !== "query") {
        warnings.push(`${where}: ${loc} parameter "${name}" ignored`);
        continue;
      }
      if (loc === "query" && PAGINATION.has(name)) continue;
      const param = toParam(deref(p.schema ?? {}) as Json, deref, loc === "path" || p.required === true, p.description);
      if (!param) {
        warnings.push(`${where}: parameter "${name}" is not a scalar; skipped`);
        continue;
      }
      tool.params[name] = param;
      if (loc === "path" && o.parents.includes(name)) filters[name] = `$${name}`;
      if (loc === "query") filters[name] = param.type === "string" && !param.enum ? { $contains: `$${name}` } : `$${name}`;
    }

    const bodyFields: string[] = [];
    const body = requestSchema(o.op, deref);
    if (body) {
      const required = new Set((body.required as string[] | undefined) ?? []);
      for (const [name, raw] of Object.entries((body.properties ?? {}) as Json)) {
        const param = toParam(deref(raw) as Json, deref, required.has(name));
        if (!param) {
          warnings.push(`${where}: body field "${name}" is not a scalar; skipped`);
          continue;
        }
        tool.params[name] ??= param;
        bodyFields.push(name);
      }
    }

    const keyRef = o.itemKey ? `$${o.itemKey}` : undefined;
    const values = Object.fromEntries([...o.parents, ...bodyFields].map((f) => [f, `$${f}`]));
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
      tool.ops.push({ update: o.table, key: keyRef!, set: Object.fromEntries(bodyFields.map((f) => [f, `$${f}`])) });
    } else {
      warnings.push(`${where}: ${o.method.toUpperCase()} is not supported by the draft; skipped`);
      names.delete(tool.name);
      continue;
    }

    if (o.method !== "get") {
      for (const name of Object.keys(tool.params)) {
        const owner = keyOwners.get(name);
        if (owner && owner !== o.table) tool.checks.push({ table: owner, key: `$${name}`, error: `${owner} \${${name}} not found` });
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
    outTables[name] = { key: t.key!, rows: t.rows.filter((r) => r[t.key!] !== undefined), fields: [...t.fields.keys()] };
  }
  return {
    name: slug(title),
    description: typeof info.description === "string" && info.description.trim() ? info.description.trim() : title,
    tables: outTables,
    tools,
    warnings,
  };
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

function toParam(schema: Json, deref: (x: unknown) => unknown, required: boolean, description?: unknown): DraftParam | undefined {
  const s = schema.allOf ? (deref((schema.allOf as unknown[])[0]) as Json) : schema;
  let type = s.type as string | undefined;
  if (!type && Array.isArray(s.enum)) type = typeof s.enum[0] === "number" ? "number" : "string";
  if (!type) type = "string";
  if (!["string", "number", "integer", "boolean"].includes(type)) return undefined;
  const param: DraftParam = { type: type as DraftParam["type"], required };
  const desc = (description ?? s.description) as string | undefined;
  if (desc) param.description = String(desc).trim();
  if (Array.isArray(s.enum)) param.enum = s.enum as (string | number)[];
  if (!required && ["string", "number", "boolean"].includes(typeof s.default)) param.default = s.default as string | number | boolean;
  return param;
}

function collectFields(acc: { fields: Map<string, Json>; rows: Json[] }, schema: Json, deref: (x: unknown) => unknown, withExamples = true) {
  const s = (schema.type === "array" ? deref(schema.items) : schema) as Json;
  if (!s || typeof s !== "object") return;
  for (const [name, raw] of Object.entries((s.properties ?? {}) as Json)) acc.fields.set(name, deref(raw) as Json);
  if (!withExamples) return;
  const examples = schema.type === "array" && Array.isArray(schema.example) ? schema.example : s.example ? [s.example] : [];
  for (const ex of examples) if (ex && typeof ex === "object" && !Array.isArray(ex)) acc.rows.push(ex as Json);
}

function responseSchemas(op: Json, deref: (x: unknown) => unknown): Json[] {
  const out: Json[] = [];
  for (const [code, raw] of Object.entries((op.responses ?? {}) as Json)) {
    if (!/^2\d\d$/.test(code)) continue;
    const content = ((deref(raw) as Json).content ?? {}) as Json;
    const media = (content["application/json"] ?? Object.values(content)[0]) as Json | undefined;
    if (media?.schema) out.push(deref(media.schema) as Json);
  }
  return out;
}

function requestSchema(op: Json, deref: (x: unknown) => unknown): Json | undefined {
  const body = deref(op.requestBody) as Json | undefined;
  const content = (body?.content ?? {}) as Json;
  const media = (content["application/json"] ?? Object.values(content)[0]) as Json | undefined;
  const schema = media?.schema ? (deref(media.schema) as Json) : undefined;
  return schema && (schema.type === "object" || schema.properties) ? schema : undefined;
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

function slug(s: string): string {
  return snake(s).replace(/_/g, "-") || "domain";
}

export function singularize(s: string): string {
  if (s.endsWith("ies")) return `${s.slice(0, -3)}y`;
  if (s.endsWith("sses") || s.endsWith("xes") || s.endsWith("ches") || s.endsWith("shes")) return s.slice(0, -2);
  if (s.endsWith("s") && !s.endsWith("ss") && !s.endsWith("us")) return s.slice(0, -1);
  return s;
}

function uniqueName(seen: Set<string>, base: string): string {
  let name = base.slice(0, 64) || "tool";
  for (let i = 2; seen.has(name); i++) name = `${base.slice(0, 60)}_${i}`;
  seen.add(name);
  return name;
}
