export type Row = Record<string, unknown>;
export type Args = Record<string, unknown>;

const WHOLE_REF = /^\$([a-zA-Z_]\w*)$/;
const INLINE_REF = /\$\{([a-zA-Z_]\w*)\}/g;

/**
 * Read a string as a template: when the whole string is "$name", the result is `lookup(name)`;
 * otherwise each "${name}" inside it is replaced by `lookup(name)`'s text. A name is a letter or _,
 * then letters, digits or _, and anything else stays literal: "$5", "$$", "$/hr", "$USD/kg", "$@type".
 * resolve() and `validate` both read strings through this, so they agree on what a reference is.
 */
export function substitute(value: string, lookup: (name: string, ref: string) => unknown): unknown {
  const whole = WHOLE_REF.exec(value);
  if (whole) return lookup(whole[1]!, value);
  return value.replace(INLINE_REF, (ref, name: string) => String(lookup(name, ref) ?? ""));
}

/** Whether "$name" refers to a param called `name`, rather than being literal text. */
export function isParamName(name: string): boolean {
  return WHOLE_REF.test(`$${name}`);
}

/** Replace "$arg" with the argument value and "${arg}" with its string form, recursively. */
export function resolve(value: unknown, args: Args): unknown {
  if (typeof value === "string") return substitute(value, (name) => (Object.hasOwn(args, name) ? args[name] : undefined));
  if (Array.isArray(value)) return value.map((v) => resolve(v, args));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, args)]));
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
  return Object.entries(where).every(([field, cond]) => test(row[field], cond));
}

/** Explain the first failing condition, for readable grader output. */
export function mismatch(row: Row, where: Row): string | undefined {
  for (const [field, cond] of Object.entries(where)) {
    if (!test(row[field], cond)) return `${field} is ${JSON.stringify(row[field])}, expected ${JSON.stringify(cond)}`;
  }
  return undefined;
}

/** The operators a where clause understands, e.g. `{ rate: { $lte: 2000 } }`. */
export const OPERATORS = ["$eq", "$ne", "$in", "$nin", "$gt", "$gte", "$lt", "$lte", "$exists", "$contains"] as const;

/**
 * Why a where clause would fail or never match at run time, one line per condition: an unknown
 * operator (which throws mid-run), or `$in` / `$nin` without a list (which matches nothing).
 */
export function operatorProblems(where: Row): string[] {
  const problems: string[] = [];
  for (const [field, cond] of Object.entries(where)) {
    if (!isOperatorObject(cond)) continue;
    for (const [op, expected] of Object.entries(cond)) {
      if (!(OPERATORS as readonly string[]).includes(op)) problems.push(`${field}: unknown operator "${op}" (use ${OPERATORS.join(", ")})`);
      else if ((op === "$in" || op === "$nin") && !Array.isArray(expected)) problems.push(`${field}: ${op} needs a list`);
    }
  }
  return problems;
}

function test(actual: unknown, cond: unknown): boolean {
  if (isOperatorObject(cond)) {
    return Object.entries(cond).every(([op, expected]) => applyOperator(op, actual, expected));
  }
  return equal(actual, cond);
}

function applyOperator(op: string, actual: unknown, expected: unknown): boolean {
  switch (op) {
    case "$eq":
      return equal(actual, expected);
    case "$ne":
      return !equal(actual, expected);
    case "$in":
      return Array.isArray(expected) && expected.some((e) => equal(actual, e));
    case "$nin":
      return Array.isArray(expected) && !expected.some((e) => equal(actual, e));
    case "$gt":
      return compare(actual, expected) > 0;
    case "$gte":
      return compare(actual, expected) >= 0;
    case "$lt":
      return compare(actual, expected) < 0;
    case "$lte":
      return compare(actual, expected) <= 0;
    case "$exists":
      return (actual !== undefined && actual !== null) === Boolean(expected);
    case "$contains":
      return (
        typeof actual === "string" &&
        typeof expected === "string" &&
        actual.toLowerCase().includes(expected.toLowerCase())
      );
    default:
      throw new Error(`Unknown operator ${op}`);
  }
}

/** Compare numbers numerically and everything else as strings. Returns NaN when not comparable. */
function compare(a: unknown, b: unknown): number {
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
