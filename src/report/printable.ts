/*
 * Text that an agent, a simulated caller, a platform's call or a results file holds, made fit to print: a terminal shows
 * it as text, so it can't start an escape sequence, ring the bell, move the cursor or set the window's title, and a
 * renderer can't show it reversed. Only what came from outside goes through here: sandtable's own colours are added
 * after, so they stay.
 */

/** C0 controls (a newline and a tab among them), DEL, C1 controls, and the bidi embedding, override and isolate controls. */
const CONTROL = "\\p{Cc}\\u202a-\\u202e\\u2066-\\u2069";
const ONE_LINE = new RegExp(`[\\s${CONTROL}]+`, "gu");
const EACH = new RegExp(`[${CONTROL}]`, "gu");
/** One character a terminal acts on rather than shows. */
export const CONTROL_CHAR = new RegExp(`[${CONTROL}]`, "u");
const LINES = new RegExp(`(?:(?![\\n\\t])[${CONTROL}])+`, "gu");

/** On one line, for a value inside a line or a Markdown cell: each run of whitespace and control characters is one space, with none at either end. */
export function printable(value: unknown): string {
  return String(value).replace(ONE_LINE, " ").trim();
}

/** Over several lines, for a message that breaks its own lines, such as an error: newlines and tabs stay, and each other run of control characters is one space. */
export function printableLines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(LINES, " ");
}

/** A copy of JSON data, such as a run, in which every string is `printable` and every key has each control character as a space, so keys that differ stay apart. */
export function printableCopy<T>(data: T): T {
  if (typeof data === "string") return printable(data) as T;
  if (Array.isArray(data)) return data.map(printableCopy) as T;
  // fromEntries, not assignment, so a key such as __proto__ stays a key.
  if (data !== null && typeof data === "object") return Object.fromEntries(Object.entries(data).map(([k, v]) => [k.replace(EACH, " "), printableCopy(v)])) as T;
  return data;
}
