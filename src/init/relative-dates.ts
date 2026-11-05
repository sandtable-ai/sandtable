import { expressionFor, isClockTime, mapTaskDates } from "../spec/clock.ts";
import type { Task } from "../spec/schema.ts";
import { isPlainObject } from "../world/match.ts";

/**
 * Dates relative to a call, for `init --transcripts`: a task drafted from a real call holds the call's dates, which are
 * past by the time the suite runs. With the call's date known, each drafted date becomes an offset from it, such as
 * `$today+2d`, on a domain with `clock: now`, so the draft holds on any day.
 */

/** How a call date is written, for `--call-date` and its errors. */
export const CALL_DATE_FORMAT = "a date, YYYY-MM-DD, or a date and time, YYYY-MM-DDTHH:MM";

/** A timestamp in a transcript: a date, then optionally a time to the minute, with any seconds, fraction and zone dropped. */
const STAMP = /(?<![\w-])(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?(?![\w-]|:\d)/g;

/**
 * The call's date, or date and time to the minute, that a transcript states: the first real date in its first five
 * non-empty lines, as `2026-03-14`, `2026-03-14T10:05` or `2026-03-14 10:05` (seconds, a fraction and a zone dropped).
 * Read from the file itself, locally. Undefined when those lines state none.
 */
export function callDateIn(text: string): string | undefined {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "").slice(0, 5);
  for (const line of lines) {
    for (const [, date, time] of line.matchAll(STAMP)) {
      if (!isClockTime(`${date}T00:00`)) continue;
      return time !== undefined && isClockTime(`${date}T${time}`) ? `${date}T${time}` : date;
    }
  }
  return undefined;
}

/** A `--call-date` as given, when it is a real date (`2026-03-14`) or date and time to the minute (`2026-03-14T10:05`). */
export function parseCallDate(value: string): string | undefined {
  const m = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.exec(value);
  return m && isClockTime(m[1] ? value : `${value}T00:00`) ? value : undefined;
}

/** A whole value that is a date, or a date and time to the minute with optional seconds. */
const WHOLE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const WHOLE_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2})?$/;
/** The same inside text, standing alone: not part of an ID such as `BK-2026-03-16`. */
const INLINE_DATE = /(?<![\w-])(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::\d{2})?)?(?![\w-]|:\d)/g;

export interface CallDates {
  task: Task;
  rows: Record<string, Record<string, unknown>[]>;
  /** Each date made relative, as `<where> <date> → <expression>`, such as `user.script[0] 2026-03-16 → ${today+2d}`. */
  changed: string[];
  /** Each date and time left literal, as `<where> <date and time>`, because the call's time isn't known. */
  literal: string[];
}

/**
 * `task` and its new seed `rows` with each date written relative to `call`, the call's date (`2026-03-14`) or date and
 * time (`2026-03-14T10:05`), in the places a trial resolves dates in, so every expression written is one it resolves.
 * A whole value that is a date becomes `$today+2d`, and a date and time `$now` with an offset in the largest exact unit
 * (`$now+90m`); in text (the caller's lines, `reply_includes`, faults' messages), `${today+2d}` and `${now+90m}`. A date
 * and time stays literal when `call` has no time. Other text, such as the description, keeps its dates. `keys` names
 * each table's key, to say which new row a change is in.
 */
export function relativeToCall(task: Task, rows: Record<string, Record<string, unknown>[]>, call: string, keys: Record<string, string>): CallDates {
  const timed = call.length > 10;
  const clock = timed ? call : `${call}T00:00`;
  const changed: string[] = [];
  const literal: string[] = [];
  const add = (list: string[], line: string) => {
    if (!list.includes(line)) list.push(line);
  };
  /** A whole value: the expression for its date, or the value. */
  const whole = (v: string, where: string): string => {
    const time = WHOLE_TIME.exec(v)?.[1];
    const date = WHOLE_DATE.test(v) ? v : time;
    if (date === undefined) return v;
    if (time !== undefined && !timed) {
      if (isClockTime(time)) add(literal, `${where} ${v}`);
      return v;
    }
    const expression = expressionFor(date, clock);
    if (expression === undefined) return v;
    add(changed, `${where} ${v} → $${expression}`);
    return `$${expression}`;
  };
  /** Text: each date in it as `${...}`. */
  const text = (v: string, where: string): string =>
    v.replace(INLINE_DATE, (found, date: string, time: string | undefined) => {
      if (time !== undefined && !timed) {
        if (isClockTime(`${date}T${time}`)) add(literal, `${where} ${found}`);
        return found;
      }
      const expression = expressionFor(time === undefined ? date : `${date}T${time}`, clock);
      if (expression === undefined) return found;
      add(changed, `${where} ${found} → \${${expression}}`);
      return `\${${expression}}`;
    });
  const value = (v: unknown, where: string): unknown => {
    if (typeof v === "string") return whole(v, where);
    if (Array.isArray(v)) return v.map((x, i) => value(x, `${where}[${i}]`));
    if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, value(x, `${where}.${k}`)]));
    return v;
  };
  const out = mapTaskDates(task, (v, at) => (at.text ? text(v, at.path) : whole(v, at.path)));
  const outRows = Object.fromEntries(
    Object.entries(rows).map(([table, list]) => [
      table,
      list.map((row, i) => {
        const key = keys[table] !== undefined ? row[keys[table]] : undefined;
        const label = `new ${table} row ${key === undefined ? `#${i + 1}` : String(key)}`;
        return Object.fromEntries(Object.entries(row).map(([field, x]) => [field, value(x, `${label} ${field}`)]));
      }),
    ]),
  );
  return { task: out, rows: outRows, changed, literal };
}

/** Whether `task` or its new `rows` hold a date where relativeToCall would write one relative to a call. */
export function holdsDates(task: Task, rows: Record<string, Record<string, unknown>[]>): boolean {
  return relativeToCall(task, rows, "2000-01-01T00:00", {}).changed.length > 0;
}

/** The review note on a task that holds dates its chat states no call date for. */
export const NO_CALL_DATE = "this chat states no call date, so its dates are literal and may be past when the suite runs: pass --call-date, or make them relative ($today+2d) by hand";

/** The review notes on a task whose dates were rewritten relative to `call`: what moved, and what stayed literal. */
export function callDateNotes(call: string, dates: Pick<CallDates, "changed" | "literal">): string[] {
  const notes: string[] = [];
  if (dates.changed.length) notes.push(`dates made relative to the call on ${call}: ${dates.changed.join(", ")}`);
  if (dates.literal.length) {
    notes.push(`this chat states its call's date, ${call}, but not its time, so its dates and times stay literal and may be past when the suite runs: ${dates.literal.join(", ")}. Make them relative ($now+2d) by hand`);
  }
  return notes;
}
