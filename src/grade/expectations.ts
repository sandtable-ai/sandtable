import { MONTHS, WEEKDAYS } from "../spec/clock.ts";
import type { CallExpect, StateAssert, Task } from "../spec/schema.ts";
import { matches, mismatch, type Row } from "../world/match.ts";
import type { World } from "../world/store.ts";
import { asciiHyphens, type CallRecord, type Violation } from "./invariants.ts";

export type CheckKind = "invariant" | "state" | "called" | "not_called" | "reply" | "runtime";

export interface CheckResult {
  id: string;
  kind: CheckKind;
  passed: boolean;
  detail: string;
}

/**
 * Deterministic grading: a trial passes only if the world ended in the expected state,
 * the required tools ran, the forbidden ones did not, and no invariant was violated.
 */
export function gradeTrial(input: {
  task: Task;
  world: World;
  calls: readonly CallRecord[];
  agentMessages: readonly string[];
  violations: readonly Violation[];
  error?: string;
}): { passed: boolean; checks: CheckResult[] } {
  const { task, world, calls, agentMessages, violations, error } = input;
  const checks: CheckResult[] = [];

  if (error) checks.push({ id: "runtime", kind: "runtime", passed: false, detail: error });

  for (const v of violations) {
    checks.push({ id: v.invariant, kind: "invariant", passed: false, detail: v.detail });
  }

  task.expect.state.forEach((a, i) => checks.push(checkState(a, i, world)));

  for (const e of task.expect.called) checks.push(checkCalled(e, calls));
  for (const e of task.expect.not_called) checks.push(checkNotCalled(e, calls));

  for (const phrase of task.expect.reply_includes) {
    const said = replyMatcher(phrase);
    const ok = agentMessages.some(said);
    checks.push({
      id: `reply:${phrase}`,
      kind: "reply",
      passed: ok,
      detail: ok ? `agent said "${phrase}"` : `agent never said "${phrase}"`,
    });
  }

  return { passed: checks.every((c) => c.passed), checks };
}

/**
 * Whether a message says `phrase`, as `reply_includes` checks it: as text, case-insensitive, with U+2010 and U+2011 read
 * as `-`. An ISO date in the phrase (`2026-11-04`), standing alone rather than in a date and time or an ID, may also be
 * said in words, as an en-US speaker says it: `November 4`, `Nov. 4th`, `4 November`, `the 4th of November`, with an
 * optional weekday before it (`Wednesday, November 4`) and year after it (`November 4, 2026`). A weekday that isn't the
 * date's, or a day or year that runs on into another number (`November 14`, `November 4,5`, `November 4, 2027`), isn't it.
 */
export function replyMatcher(phrase: string): (message: string) => boolean {
  const wanted = asciiHyphens(phrase).toLowerCase();
  let source = "";
  let from = 0;
  for (const m of wanted.matchAll(ISO_DATE)) {
    const words = spokenDate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (words === undefined) continue;
    source += `${escapeRegex(wanted.slice(from, m.index))}(?:${escapeRegex(m[0])}|${words})`;
    from = m.index + m[0].length;
  }
  if (!source) return (message) => asciiHyphens(message).toLowerCase().includes(wanted);
  const pattern = new RegExp(source + escapeRegex(wanted.slice(from)));
  return (message) => pattern.test(asciiHyphens(message).toLowerCase());
}

/** An ISO date on its own: not part of a date and time (`2026-11-02t11:00`, lowercased) or of an ID (`bk-2026-11-04`). */
const ISO_DATE = /(?<![\w-])(\d{4})-(\d{2})-(\d{2})(?![\w-])/g;

/** Other spellings of a day's or a month's name, besides its full name and its first three letters. */
const MORE_NAMES: Record<string, string[]> = { tuesday: ["tues"], wednesday: ["weds"], thursday: ["thur", "thurs"], september: ["sept"] };

/** A name as a regex alternation of how it is written, lowercase, longest first: `wednesday|weds|wed`. */
const spellings = (name: string) => {
  const full = name.toLowerCase();
  return [...new Set([full, ...(MORE_NAMES[full] ?? []), full.slice(0, 3)])].join("|");
};

/** The suffix of a day of the month said as an ordinal: `st` for 1, `nd` for 22, `th` for 11. */
const ordinal = (day: number) => (day % 100 >= 11 && day % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][day % 10] ?? "th");

/**
 * A regex, over lowercased text, for the date `year`-`month`-`day` in words (see replyMatcher), or undefined when it is
 * no real date, such as 2026-02-30. Weekday and month names are written out here rather than read from Intl, as in
 * describeClock, so a check grades the same on every machine.
 */
function spokenDate(year: number, month: number, day: number): string | undefined {
  const at = new Date(Date.UTC(year, month - 1, day));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return undefined;
  const weekday = at.getUTCDay();
  const others = WEEKDAYS.filter((_, i) => i !== weekday).map(spellings).join("|");
  const name = `(?:${spellings(MONTHS[month - 1]!)})(?![a-z])\\.?`;
  const nth = `0?${day}(?:${ordinal(day)})?`;
  const monthFirst = `${name}\\s+${nth}`;
  const dayFirst = `(?:the\\s+)?(?<![\\w.,-])${nth}(?:\\s+of)?\\s+${name}`;
  return (
    // Not right after another weekday, as in "Tuesday, November 4" when it is a Wednesday.
    `(?<!\\b(?:${others})\\.?,?\\s+(?:the\\s+)?)` +
    `(?:\\b(?:${spellings(WEEKDAYS[weekday]!)})\\.?,?\\s+)?` +
    `\\b(?:${monthFirst}|${dayFirst})(?:,?\\s+${year})?` +
    // Not running on into another word or number: a longer day or a wrong ordinal, a list (4,5 or 4.5), or another year.
    `(?![a-z\\d]|[.,]\\d|,?\\s+\\d{4}(?!\\d))`
  );
}

/** Text as a regex that matches it literally. */
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The tool a `called` or `not_called` entry names. */
export function expectedTool(e: CallExpect): string {
  return typeof e === "string" ? e : e.tool;
}

/**
 * The check id of a `called` or `not_called` entry: `called:<tool>` for a name, and for `{ tool, args }`
 * each condition in spec order as `field=<JSON>`, e.g. `called:transfer_to_human(reason="billing")`.
 */
export function callCheckId(kind: "called" | "not_called", e: CallExpect): string {
  if (typeof e === "string") return `${kind}:${e}`;
  return `${kind}:${e.tool}(${Object.entries(e.args).map(([field, cond]) => `${field}=${JSON.stringify(cond)}`).join(", ")})`;
}

function checkCalled(e: CallExpect, calls: readonly CallRecord[]): CheckResult {
  const id = callCheckId("called", e);
  const tool = expectedTool(e);
  const ok = calls.filter((c) => c.name === tool && c.ok);
  if (typeof e === "string") {
    const passed = ok.length > 0;
    return { id, kind: "called", passed, detail: passed ? `${tool} succeeded` : `${tool} was never called successfully` };
  }
  if (ok.some((c) => matches(c.args, e.args))) return { id, kind: "called", passed: true, detail: `${tool} succeeded with matching arguments` };
  const failed = calls.filter((c) => c.name === tool && !c.ok && matches(c.args, e.args)).length;
  const detail =
    ok.length > 0
      ? `${tool} succeeded ${ok.length}x, never with matching arguments: ${closestMismatch(ok, e.args)}`
      : failed > 0
        ? `${tool} was called ${failed}x with matching arguments but never succeeded`
        : `${tool} was never called successfully`;
  return { id, kind: "called", passed: false, detail };
}

function checkNotCalled(e: CallExpect, calls: readonly CallRecord[]): CheckResult {
  const id = callCheckId("not_called", e);
  const tool = expectedTool(e);
  if (typeof e === "string") {
    const n = calls.filter((c) => c.name === tool).length;
    return { id, kind: "not_called", passed: n === 0, detail: n === 0 ? `${tool} not called` : `${tool} was called ${n}x` };
  }
  const n = calls.filter((c) => c.name === tool && matches(c.args, e.args)).length;
  return {
    id,
    kind: "not_called",
    passed: n === 0,
    detail: n === 0 ? `${tool} not called with matching arguments` : `${tool} was called ${n}x with matching arguments`,
  };
}

/** The first failing condition of the call that fails the fewest, the earliest on a tie. */
function closestMismatch(calls: readonly CallRecord[], args: Row): string {
  const failing = (c: CallRecord) => Object.entries(args).filter(([field, cond]) => !matches(c.args, { [field]: cond })).length;
  const closest = calls.reduce((best, c) => (failing(c) < failing(best) ? c : best));
  return mismatch(closest.args, args) ?? "";
}

/**
 * A trial that ended in an error, such as a rate limit or timeout that outlasted the adapter's retries or an
 * agent endpoint that went down, is skipped: the conversation never finished, so it says nothing about the
 * agent, and it is left out of pass^k. Unless the agent had already broken something that finishing the
 * conversation could not undo, a hard invariant or a tool it must not call: then the trial failed like any
 * other, so an agent that crashes can't hide what it broke before the crash.
 */
export function isSkipped(checks: readonly CheckResult[], error: string | undefined): boolean {
  return error !== undefined && !checks.some((c) => !c.passed && (c.kind === "invariant" || c.kind === "not_called"));
}

function checkState(a: StateAssert, i: number, world: World): CheckResult {
  const id = `state:${a.table}${a.key ? `[${a.key}]` : ""}#${i + 1}`;
  if (a.key !== undefined) {
    const row = world.get(a.table, a.key);
    if (a.count === 0) {
      return { id, kind: "state", passed: !row, detail: row ? `${a.table} ${a.key} exists but should not` : `${a.table} ${a.key} absent` };
    }
    if (!row) return { id, kind: "state", passed: false, detail: `${a.table} ${a.key} not found` };
    const why = a.fields ? mismatch(row, a.fields) : undefined;
    return { id, kind: "state", passed: !why, detail: why ? `${a.table} ${a.key}: ${why}` : `${a.table} ${a.key} as expected` };
  }
  const rows = world.list(a.table).filter((r) => matches(r, a.where ?? {}));
  const passed = a.count === undefined ? rows.length >= 1 : rows.length === a.count;
  const expected = a.count === undefined ? "at least 1" : String(a.count);
  return {
    id,
    kind: "state",
    passed,
    detail: `${rows.length} ${a.table} row(s) match ${JSON.stringify(a.where ?? {})} (expected ${expected})`,
  };
}
