export type Row = Record<string, unknown>;
export type Args = Record<string, unknown>;

const NAME = /^[a-zA-Z_]\w*$/;
// A name, then an optional path into it: "$address.zip", "${items.0.sku}".
const WHOLE_REF = /^\$([a-zA-Z_]\w*)((?:\.\w+)*)$/;
const INLINE_REF = /\$\{([a-zA-Z_]\w*)((?:\.\w+)*)\}/g;

/** What a lookup returns to leave a reference as the literal text it is. */
export const LITERAL: unique symbol = Symbol("literal");

/**
 * Read a string as a template: when the whole string is "$name", the result is `lookup(name)`;
 * otherwise each "${name}" inside it is replaced by `lookup(name)`'s text. A name is a letter or _,
 * then letters, digits or _, and anything else stays literal: "$5", "$$", "$/hr", "$USD/kg", "$@type".
 * A name can go on with a path, as in "$address.zip" or "${items.0.sku}", and `lookup` gets its segments;
 * it returns LITERAL to keep the reference as text, as a path into a param that has no fields is.
 * resolve() and `validate` both read strings through this, so they agree on what a reference is.
 */
export function substitute(value: string, lookup: (name: string, ref: string, path: string[]) => unknown): unknown {
  const whole = WHOLE_REF.exec(value);
  if (whole) {
    const found = lookup(whole[1]!, value, segments(whole[2]!));
    return found === LITERAL ? value : found;
  }
  return value.replace(INLINE_REF, (ref, name: string, path: string) => {
    const found = lookup(name, ref, segments(path));
    return found === LITERAL ? ref : String(found ?? "");
  });
}

const segments = (path: string) => (path ? path.slice(1).split(".") : []);

/** Whether "$name" refers to a param called `name`, rather than being literal text. */
export function isParamName(name: string): boolean {
  return NAME.test(name);
}

/** The value at `path` inside `value`: a field of an object, or a numeric index into an array. */
export function valueAt(value: unknown, path: readonly string[]): unknown {
  let cur = value;
  for (const seg of path) {
    if (Array.isArray(cur) && /^\d+$/.test(seg)) cur = cur[Number(seg)];
    else if (isPlainObject(cur) && Object.hasOwn(cur, seg)) cur = cur[seg];
    else return undefined;
  }
  return cur;
}

/** The params a template's references can reach into: only an object or an array param has a path. */
type ParamTypes = Record<string, { type: string }>;

/**
 * Replace "$arg" with the argument value and "${arg}" with its string form, recursively. "$arg.field" reads
 * a field of an object or array param; the same text after any other param stays literal, as it always was.
 */
export function resolve(value: unknown, args: Args, params: ParamTypes = {}): unknown {
  if (typeof value === "string") {
    return substitute(value, (name, _ref, path) => {
      if (!path.length) return Object.hasOwn(args, name) ? args[name] : undefined;
      const type = Object.hasOwn(params, name) ? params[name]!.type : undefined;
      if (type !== "object" && type !== "array") return LITERAL;
      return valueAt(Object.hasOwn(args, name) ? args[name] : undefined, path);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolve(v, args, params));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, args, params)]));
  }
  return value;
}

/**
 * Drop conditions whose value resolved to undefined, so optional tool params
 * that the agent did not pass do not filter anything.
 */
export function pruneUndefined(where: Row): Row {
  const out: Row = {};
  for (const [field, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (isOperatorObject(cond)) {
      const ops = Object.fromEntries(Object.entries(cond).filter(([, v]) => v !== undefined));
      if (Object.keys(ops).length === 0) continue;
      out[field] = ops;
      continue;
    }
    out[field] = cond;
  }
  return out;
}

export function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([field, cond]) => test(fieldValue(row, field), cond));
}

/**
 * A row's field. A dotted name such as "address.zip" reads a nested value, unless the row has a field
 * with that literal name.
 */
export function fieldValue(row: Row, field: string): unknown {
  if (Object.hasOwn(row, field) || !field.includes(".")) return row[field];
  return valueAt(row, field.split("."));
}

/** Explain the first failing condition, for readable grader output. */
export function mismatch(row: Row, where: Row): string | undefined {
  for (const [field, cond] of Object.entries(where)) {
    const actual = fieldValue(row, field);
    if (!test(actual, cond)) return `${field} is ${JSON.stringify(actual)}, expected ${JSON.stringify(cond)}`;
  }
  return undefined;
}

/**
 * The operators a where clause understands, e.g. `{ rate: { $lte: 2000 } }`, each as a test of the
 * field's value against the operator's. `validate` and matching both read this one table.
 */
const OPERATOR_TESTS: Record<string, (actual: unknown, expected: unknown) => boolean> = {
  $eq: (actual, expected) => equal(actual, expected),
  $ne: (actual, expected) => !equal(actual, expected),
  $in: (actual, expected) => Array.isArray(expected) && expected.some((e) => equal(actual, e)),
  $nin: (actual, expected) => Array.isArray(expected) && !expected.some((e) => equal(actual, e)),
  $gt: (actual, expected) => compare(actual, expected) > 0,
  $gte: (actual, expected) => compare(actual, expected) >= 0,
  $lt: (actual, expected) => compare(actual, expected) < 0,
  $lte: (actual, expected) => compare(actual, expected) <= 0,
  $exists: (actual, expected) => (actual !== undefined && actual !== null) === Boolean(expected),
  $regex: (actual, expected) => {
    if (typeof actual !== "string" || typeof expected !== "string") return false;
    // Tool arguments can supply a pattern after static validation.
    try { return new RegExp(expected).test(actual); }
    catch { return false; }
  },
  // Text that contains a string (case-insensitive), or a list with an element that matches: a plain object
  // matches an element like a where clause, operators included; anything else, by equality.
  $contains: (actual, expected) => {
    if (Array.isArray(actual)) return actual.some((element) => elementMatches(element, expected));
    return typeof actual === "string" && typeof expected === "string" && actual.toLowerCase().includes(expected.toLowerCase());
  },
};

function elementMatches(element: unknown, cond: unknown): boolean {
  if (isPlainObject(cond) && !isOperatorObject(cond)) return isPlainObject(element) && matches(element, cond);
  return test(element, cond);
}

export const OPERATORS: readonly string[] = Object.keys(OPERATOR_TESTS);

/**
 * Why a where clause would fail or never match at run time, one line per problem, each starting with the
 * field: an unknown operator (which throws mid-run), `$in` / `$nin` without a list (which matches
 * nothing), or a field named like an operator, such as `$or` (no row has it, so it matches nothing).
 * With `refs`, the clause belongs to a tool, whose "$arg" references are replaced by an argument: a
 * single value, so never the list `$in` needs.
 */
export function operatorProblems(where: Row, opts: { refs?: boolean } = {}): string[] {
  return readClause(where, opts).problems;
}

/**
 * What a where clause says but doesn't do, one line per finding, each starting with the field: a plain key beside
 * operators, which makes the whole object an equality (see isOperatorObject), or a `$exists` that isn't true or false,
 * which is read by whether it's truthy. `opts` as in operatorProblems. 1.4 accepted both, so these stay warnings until 2.0.
 */
export function operatorWarnings(where: Row, opts: { refs?: boolean } = {}): string[] {
  return readClause(where, opts).warnings;
}

function readClause(where: Row, opts: { refs?: boolean }): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  for (const [field, cond] of Object.entries(where)) {
    if (field.startsWith("$")) {
      problems.push(`${field}: a where clause has no operators at the top, only fields, and all of them must hold`);
      continue;
    }
    if (!isOperatorObject(cond)) {
      warnings.push(...plainKeyWarnings(field, cond));
      continue;
    }
    for (const [op, expected] of Object.entries(cond)) {
      if (op === "$contains" && isPlainObject(expected)) {
        // An element's where clause, or operators on the element itself.
        const onElement = isOperatorObject(expected);
        const inner = readClause(onElement ? { [field]: expected } : expected, opts);
        const at = onElement ? "" : `${field}.$contains.`;
        problems.push(...inner.problems.map((p) => at + p));
        warnings.push(...inner.warnings.map((w) => at + w));
        continue;
      }
      const ref = opts.refs && typeof expected === "string" && WHOLE_REF.test(expected);
      if (!Object.hasOwn(OPERATOR_TESTS, op)) problems.push(`${field}: unknown operator "${op}" (use ${OPERATORS.join(", ")})`);
      else if ((op === "$in" || op === "$nin") && !Array.isArray(expected)) {
        problems.push(`${field}: ${op} needs a list${ref ? `, and "${expected}" is a single argument value: list the values, or use ${op === "$in" ? "$eq" : "$ne"}` : ""}`);
      }
      else if (op === "$regex") {
        if (typeof expected !== "string") problems.push(`${field}: $regex needs a string pattern`);
        else {
          try { new RegExp(expected); }
          catch { problems.push(`${field}: invalid $regex pattern ${JSON.stringify(expected)}`); }
        }
      }
      else if (op === "$exists" && typeof expected !== "boolean" && !ref) {
        warnings.push(`${field}: $exists takes true or false, and ${JSON.stringify(expected)} is read as ${Boolean(expected)}. Write true or false; 2.0 will reject this.`);
      }
    }
  }
  return { problems, warnings };
}

/** A line for each plain key of an object that also has operators. An object with no operators is a plain equality, as on an object field. */
function plainKeyWarnings(field: string, cond: unknown): string[] {
  if (!isPlainObject(cond)) return [];
  const keys = Object.keys(cond);
  const operators = keys.filter((k) => k.startsWith("$"));
  if (!operators.length) return [];
  return keys
    .filter((k) => !k.startsWith("$"))
    .map((k) => `${field}: the plain key "${k}" beside ${operators.join(", ")} turns this object into an equality check, so no operator in it is read. Put a $ on "${k}" if it's an operator, or take it out; 2.0 will reject this.`);
}

function test(actual: unknown, cond: unknown): boolean {
  if (isOperatorObject(cond)) {
    return Object.entries(cond).every(([op, expected]) => {
      // Own keys only, so "$constructor" is as unknown as "$like". `validate` rejects both before a run.
      if (!Object.hasOwn(OPERATOR_TESTS, op)) throw new Error(`Unknown operator ${op}`);
      return OPERATOR_TESTS[op]!(actual, expected);
    });
  }
  return equal(actual, cond);
}

/** Compare numbers numerically and everything else as strings. Returns NaN when not comparable. */
export function compare(a: unknown, b: unknown): number {
  if (a === undefined || a === null || b === undefined || b === null) return Number.NaN;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // YAML reads an unquoted 100101 as a number while seed rows often hold "100101": treat a number
  // and a string with exactly the same digits as equal. "00123" still differs from 123.
  if (typeof a === "number" && typeof b === "string") return String(a) === b;
  if (typeof a === "string" && typeof b === "number") return a === String(b);
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function isPlainObject(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOperatorObject(value: unknown): value is Row {
  return isPlainObject(value) && Object.keys(value).length > 0 && Object.keys(value).every((k) => k.startsWith("$"));
}
