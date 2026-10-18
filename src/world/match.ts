export type Row = Record<string, unknown>;
export type Args = Record<string, unknown>;

const WHOLE_REF = /^\$([a-zA-Z_]\w*)$/;
const INLINE_REF = /\$\{([a-zA-Z_]\w*)\}/g;

/** Replace "$arg" with the argument value and "${arg}" with its string form, recursively. */
export function resolve(value: unknown, args: Args): unknown {
  if (typeof value === "string") {
    const whole = WHOLE_REF.exec(value);
    if (whole) return args[whole[1]!];
    return value.replace(INLINE_REF, (_, name: string) => String(args[name] ?? ""));
  }
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
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function isPlainObject(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOperatorObject(value: unknown): value is Row {
  return isPlainObject(value) && Object.keys(value).length > 0 && Object.keys(value).every((k) => k.startsWith("$"));
}
