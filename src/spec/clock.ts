import { isPlainObject } from "../world/match.ts";
import type { Domain, Task } from "./schema.ts";

/**
 * The simulation clock. A domain's or a task's `clock` is a date and time to the minute with no time zone, such as
 * `2026-11-02T09:00`, or `now`: the minute each trial starts, on the machine running sandtable. Dates relative to it
 * are `$today` (`2026-11-02`) and `$now` (`2026-11-02T09:00`), each with an optional offset: `$today+2d`, `$now-90m`,
 * `$now+3h`, `$now+1d`, and `${today+2d}` inside text. The arithmetic is on the wall clock, so there are no
 * daylight-saving jumps. Each trial resolves them once, with resolveTrial, and everything after it sees plain values.
 */

/** A clock's date and time, as the spec writes it. */
const TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export const CLOCK_MESSAGE = "a clock is now, or a date and time to the minute with no time zone, such as 2026-11-02T09:00";

/** An expression's text after its `$`, or inside `${}`: a name, then an optional offset. */
const EXPRESSION = /^(today|now)(?:([+-])(\d+)([dhm]))?$/;
/** A whole string that is meant as a date expression, well-formed or not: `$today`, `$now-3h`, `$today+2x`. */
const WHOLE = /^\$(today|now)(?:[+-].*)?$/s;
/** The same inside text: `${today}`, `${now+90m}`, `${today+2h}`. */
const INLINE = /\$\{(today|now)(?:[+-][^}]*)?\}/g;

const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000 } as const;

/** The names that are dates, unless a tool has a param by that name. */
const NAMES = ["today", "now"] as const;

/** A clock's minute as milliseconds since the epoch, reading its fields as UTC: wall-clock arithmetic, with no time zone. */
const clockMs = (clock: string) => {
  const [, y, mo, d, h, mi] = TIME.exec(clock)!.map(Number);
  return Date.UTC(y!, mo! - 1, d!, h!, mi!);
};

/** `ms` as a clock's text: the UTC fields, to the minute. */
const minuteOf = (ms: number) => new Date(ms).toISOString().slice(0, 16);

/** Whether `value` is a clock's date and time: well-formed and a real minute, so not 2026-02-30T09:00 or 24:00. */
export function isClockTime(value: string): boolean {
  return TIME.test(value) && minuteOf(clockMs(value)) === value;
}

/**
 * A `clock` value as the spec keeps it, or undefined when it isn't one: `now`, or a date and time. A Date, as a YAML
 * timestamp parses or as code builds one, is read as that minute in UTC, which is how YAML reads a timestamp with no zone.
 */
export function clockFrom(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : minuteOf(Math.floor(value.getTime() / 60_000) * 60_000);
  return typeof value === "string" && (value === "now" || isClockTime(value)) ? value : undefined;
}

/** The minute `date` falls in on this machine's clock, as a clock's text: what `clock: now` reads. */
export function localMinute(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The clock a trial of `task` runs on, as the spec writes it: the task's, else its domain's. */
export function writtenClock(domain: Pick<Domain, "clock">, task?: Pick<Task, "clock">): string | undefined {
  return task?.clock ?? domain.clock;
}

/** The minute a trial of `task` starts at: its written clock, with `now` read from `now`. Undefined without a clock. */
export function trialClock(domain: Pick<Domain, "clock">, task: Pick<Task, "clock"> | undefined, now: Date = new Date()): string | undefined {
  const clock = writtenClock(domain, task);
  return clock === "now" ? localMinute(now) : clock;
}

/** The value of an expression's text (`today+2d`) at `clock`, or undefined when it isn't a well-formed one. */
function evaluate(body: string, clock: string): string | undefined {
  const m = EXPRESSION.exec(body);
  if (!m) return undefined;
  const [, name, sign, n, unit] = m;
  // $today counts in days only: $today+2h would be a time, not a date.
  if (name === "today" && unit !== undefined && unit !== "d") return undefined;
  const offset = sign ? (sign === "-" ? -1 : 1) * Number(n) * UNIT_MS[unit as keyof typeof UNIT_MS] : 0;
  const at = new Date(clockMs(clock) + offset);
  // An offset that leaves the four-digit years is no date a seed row could hold.
  if (Number.isNaN(at.getTime()) || at.getUTCFullYear() < 0 || at.getUTCFullYear() > 9999) return undefined;
  return name === "today" ? at.toISOString().slice(0, 10) : at.toISOString().slice(0, 16);
}

/**
 * The expression, without its `$`, that resolves to `value` at `clock`: the inverse of evaluate, for a tool that writes
 * dates, such as `init --transcripts`. A date (`2026-11-04`) is `today`, `today+2d` or `today-1d`; a date and time to the
 * minute (`2026-11-02T10:30`) is `now` with an offset in the largest unit that is exact: `now+90m`, `now+3h`, `now-1d`.
 * Undefined for anything else.
 */
export function expressionFor(value: string, clock: string): string | undefined {
  const signed = (n: number, unit: string) => `${n > 0 ? "+" : "-"}${Math.abs(n)}${unit}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && isClockTime(`${value}T00:00`)) {
    const days = Math.round((clockMs(`${value}T00:00`) - clockMs(`${clock.slice(0, 10)}T00:00`)) / UNIT_MS.d);
    return days === 0 ? "today" : `today${signed(days, "d")}`;
  }
  if (!isClockTime(value)) return undefined;
  const minutes = Math.round((clockMs(value) - clockMs(clock)) / UNIT_MS.m);
  if (minutes === 0) return "now";
  if (minutes % 1440 === 0) return `now${signed(minutes / 1440, "d")}`;
  return minutes % 60 === 0 ? `now${signed(minutes / 60, "h")}` : `now${signed(minutes, "m")}`;
}

/** A whole-string date expression's value at `clock`: `$today+2d` is `2026-11-04` at 2026-11-02T09:00. Undefined for anything else. */
export function dateOf(value: string, clock: string): string | undefined {
  return value.startsWith("$") ? evaluate(value.slice(1), clock) : undefined;
}

/** Text with each `${today+2d}` and `${now}` in it replaced by its value at `clock`; other references stay as they are. */
export function interpolateDates(text: string, clock: string, shadow: ReadonlySet<string> = NONE): string {
  return text.replace(INLINE, (ref, name: string) => (shadow.has(name) ? ref : evaluate(ref.slice(2, -1), clock) ?? ref));
}

const NONE: ReadonlySet<string> = new Set();

/** The days of the week and the months in en-US, from Sunday and January: how a clock is told, and how a reply may say a date. */
export const WEEKDAYS: readonly string[] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const MONTHS: readonly string[] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * A clock as an en-US speaker says it, such as `Monday, November 2, 2026, 9:00 AM`. Written out here rather than with
 * Intl, whose output depends on the machine's locale data (`at`, a narrow no-break space before `AM`), so a prompt is
 * the same everywhere.
 */
export function describeClock(clock: string): string {
  const at = new Date(clockMs(clock));
  const hours = at.getUTCHours();
  const minutes = String(at.getUTCMinutes()).padStart(2, "0");
  return `${WEEKDAYS[at.getUTCDay()]}, ${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}, ${at.getUTCFullYear()}, ${hours % 12 || 12}:${minutes} ${hours < 12 ? "AM" : "PM"}`;
}

/**
 * How a place reads its strings: `value`, a whole string such as a seed field (`$today+2d`); `text`, inside text such as a
 * caller's instructions (`${today+2d}`); `both`, a tool's ops and checks, where `$arg` and `${arg}` already work.
 */
type Mode = "value" | "text" | "both";

/**
 * Called with every string in a place a date resolves: returns what the string becomes. `lenient` marks the places that
 * resolve since 1.5, where 1.4 took any string as text: validate warns about a date there that can't resolve, rather than
 * rejecting it, until 2.0.
 */
type Visit = (value: string, at: { mode: Mode; path: string; shadow: ReadonlySet<string>; lenient: boolean }) => string;

function walk<T>(value: T, mode: Mode, path: string, visit: Visit, shadow: ReadonlySet<string> = NONE, lenient = false): T {
  if (typeof value === "string") return visit(value, { mode, path, shadow, lenient }) as T;
  if (Array.isArray(value)) return value.map((v, i) => walk(v, mode, `${path}[${i}]`, visit, shadow, lenient)) as T;
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, mode, `${path}.${k}`, visit, shadow, lenient)])) as T;
  return value;
}

type Params = Domain["tools"][number]["params"];

/**
 * A tool's params with `visit` applied to each `default`, a whole value like a seed field, and to the defaults of the
 * `properties` of an object param and of an array's items. Nothing else in a param is a place a date resolves.
 */
function mapParams(params: Params, path: string, visit: Visit, shadow: ReadonlySet<string>): Params {
  const param = (p: Params[string], at: string): Params[string] => ({
    ...p,
    ...(p.default !== undefined ? { default: walk(p.default, "value", `${at}.default`, visit, shadow, true) } : {}),
    ...(p.properties ? { properties: mapParams(p.properties, `${at}.properties`, visit, shadow) } : {}),
    ...(p.items ? { items: param(p.items, `${at}.items`) } : {}),
  });
  return Object.fromEntries(Object.entries(params).map(([name, p]) => [name, param(p, `${path}.${name}`)]));
}

/**
 * The domain with `visit` applied to every string in the places a date resolves: the policy, seed rows, tools' params'
 * defaults, ops and checks, and invariants' `where` and `when`. In a tool with a param named `today` or `now`, that
 * name is the param.
 */
function mapDomain(domain: Domain, visit: Visit): Domain {
  return {
    ...domain,
    policy: walk(domain.policy, "text", "policy", visit, NONE, true),
    world: { tables: Object.fromEntries(Object.entries(domain.world.tables).map(([name, t]) => [name, { ...t, rows: walk(t.rows, "value", `world.tables.${name}.rows`, visit) }])) },
    tools: domain.tools.map((t) => {
      const shadow = new Set(NAMES.filter((n) => Object.hasOwn(t.params, n)));
      return {
        ...t,
        params: mapParams(t.params, `tools.${t.name}.params`, visit, shadow),
        checks: walk(t.checks, "both", `tools.${t.name}.checks`, visit, shadow),
        ops: walk(t.ops, "both", `tools.${t.name}.ops`, visit, shadow),
      };
    }),
    invariants: domain.invariants.map((inv) => {
      const at = `invariants.${inv.id}`;
      if ("require" in inv) return { ...inv, require: { ...inv.require, where: walk(inv.require.where, "value", `${at}.require.where`, visit) } };
      if ("never" in inv && inv.never.when) return { ...inv, never: { ...inv.never, when: walk(inv.never.when, "value", `${at}.never.when`, visit) } };
      if ("max_count" in inv && inv.max_count.when) return { ...inv, max_count: { ...inv.max_count, when: walk(inv.max_count.when, "value", `${at}.max_count.when`, visit) } };
      return inv;
    }),
  };
}

/**
 * The task with `visit` applied to every string in the places a date resolves: its `given` rows and context, events,
 * faults' messages, `expect` (state, `called`/`not_called` args, and `reply_includes`), `reference` args, and the
 * caller's instructions, opening and script.
 */
function mapTask(task: Task, visit: Visit): Task {
  const at = `tasks.${task.id}`;
  const { instructions, opening, script } = task.user;
  return {
    ...task,
    user: {
      ...task.user,
      instructions: walk(instructions, "text", `${at}.user.instructions`, visit),
      ...(opening !== undefined ? { opening: walk(opening, "text", `${at}.user.opening`, visit) } : {}),
      ...(script !== undefined ? { script: walk(script, "text", `${at}.user.script`, visit) } : {}),
    },
    ...(task.given ? { given: walk(task.given, "value", `${at}.given`, visit) } : {}),
    ...(task.events ? { events: walk(task.events, "value", `${at}.events`, visit) } : {}),
    ...(task.faults ? { faults: task.faults.map((f, i) => (f.message === undefined ? f : { ...f, message: walk(f.message, "text", `${at}.faults[${i}].message`, visit, NONE, true) })) } : {}),
    ...(task.reference ? { reference: task.reference.map((c, i) => ({ ...c, args: walk(c.args, "value", `${at}.reference[${i}].args`, visit) })) } : {}),
    expect: {
      ...task.expect,
      state: walk(task.expect.state, "value", `${at}.expect.state`, visit),
      called: walk(task.expect.called, "value", `${at}.expect.called`, visit),
      not_called: walk(task.expect.not_called, "value", `${at}.expect.not_called`, visit),
      reply_includes: walk(task.expect.reply_includes, "text", `${at}.expect.reply_includes`, visit, NONE, true),
    },
  };
}

/**
 * `task` with `visit` applied to every string in the places a trial resolves dates in (see mapTask), each with whether
 * the place reads dates inside text (`${today+2d}`) or as a whole value (`$today+2d`), and its path in the task, such
 * as `user.instructions` or `reference[0].args.date`. For a tool that writes dates, such as `init --transcripts`, so
 * every expression it writes is one a trial resolves.
 */
export function mapTaskDates(task: Task, visit: (value: string, at: { text: boolean; path: string }) => string): Task {
  const prefix = `tasks.${task.id}.`;
  return mapTask(task, (value, { mode, path }) => visit(value, { text: mode === "text", path: path.slice(prefix.length) }));
}

/** Replaces each date expression a place reads with its value at `clock`. */
const resolver =
  (clock: string): Visit =>
  (value, { mode, shadow }) => {
    if (mode !== "text") {
      const whole = WHOLE.exec(value);
      const resolved = whole && !shadow.has(whole[1]!) ? dateOf(value, clock) : undefined;
      if (resolved !== undefined) return resolved;
    }
    return mode === "value" ? value : interpolateDates(value, clock, shadow);
  };

/**
 * One `reply_includes` phrase as a trial resolved it, in pieces: text, and each date that a `${today...}` in the phrase
 * as written resolved to, which a reply may also say in words. Joined, the pieces are the resolved phrase. A date the
 * phrase wrote literally is text: it matches only as written, as it did before dates resolved there.
 */
export type ResolvedPhrase = readonly { text: string; date?: true }[];

/** A `reply_includes` phrase resolved at `clock`, in pieces (see ResolvedPhrase). */
function phrasePieces(phrase: string, clock: string): { text: string; date?: true }[] {
  const pieces: { text: string; date?: true }[] = [];
  let from = 0;
  for (const m of phrase.matchAll(INLINE)) {
    const value = evaluate(m[0].slice(2, -1), clock);
    if (value === undefined) continue;
    pieces.push({ text: phrase.slice(from, m.index) }, m[1] === "today" ? { text: value, date: true } : { text: value });
    from = m.index + m[0].length;
  }
  pieces.push({ text: phrase.slice(from) });
  return pieces;
}

/**
 * The domain and task with every date expression resolved at `clock`, and `clock` recorded as the clock of both, so
 * the prompts tell it. The domain's `tasks` stay as written: a trial reads only its own task. `phrases` are the task's
 * `reply_includes` resolved in pieces, which tell the reply check the dates it may hear in words (see ResolvedPhrase).
 */
export function resolveDates(domain: Domain, task: Task, clock: string): { domain: Domain; task: Task; phrases: ResolvedPhrase[] } {
  const visit = resolver(clock);
  return {
    domain: { ...mapDomain(domain, visit), clock },
    task: { ...mapTask(task, visit), ...(task.clock !== undefined ? { clock } : {}) },
    phrases: task.expect.reply_includes.map((p) => phrasePieces(p, clock)),
  };
}

/**
 * What one trial of `task` runs on: the domain and task with their dates resolved at the trial's clock, read from `now`
 * for `clock: now`, that clock, and the task's `reply_includes` in pieces (see resolveDates). Without a clock, the domain
 * and task themselves, unchanged.
 */
export function resolveTrial(domain: Domain, task: Task, now: Date = new Date()): { domain: Domain; task: Task; clock?: string; phrases?: ResolvedPhrase[] } {
  const clock = trialClock(domain, task, now);
  return clock === undefined ? { domain, task } : { ...resolveDates(domain, task, clock), clock };
}

/** Why a date expression is not one, by its name. */
const MALFORMED = {
  today: "$today takes an offset in days, such as $today+2d",
  now: "an offset is a whole number of d, h or m, such as $now+90m or $now-3h",
};

/**
 * Whether a domain or any of its tasks sets a clock. A domain that sets none reads `$today` and `$now` as it did before
 * clocks existed (1.2): as text, which validate warns about rather than rejects (see unclockedDates), until 2.0.
 */
export function usesClock(domain: Domain): boolean {
  return domain.clock !== undefined || domain.tasks.some((t) => t.clock !== undefined);
}

/** The date expressions in one string of a place that reads them as `mode` says, except a tool's own params. */
function expressions(value: string, mode: Mode, shadow: ReadonlySet<string>): { ref: string; name: keyof typeof MALFORMED; body: string }[] {
  const found: { ref: string; name: keyof typeof MALFORMED; body: string }[] = [];
  const whole = mode !== "text" ? WHOLE.exec(value) : null;
  if (whole && !shadow.has(whole[1]!)) found.push({ ref: value, name: whole[1] as keyof typeof MALFORMED, body: value.slice(1) });
  if (mode !== "value") {
    for (const m of value.matchAll(INLINE)) if (!shadow.has(m[1]!)) found.push({ ref: m[0], name: m[1] as keyof typeof MALFORMED, body: m[0].slice(2, -1) });
  }
  return found;
}

/**
 * What `validate` warns about in a domain that sets no clock anywhere: each string that reads as a date expression. It
 * stays text, as it did before 1.3, when validate accepted it, so 1.3 warns instead of rejecting the domain; 2.0 will
 * reject it. In a tool's ops or checks, `$today`, `$now`, `${today}` and `${now}` read as references to a param, and
 * one the tool doesn't have is an error, as it was before 1.3, so they aren't warned about here.
 */
function unclockedDates(domain: Domain): string[] {
  const warnings: string[] = [];
  const visit: Visit = (value, { mode, path, shadow }) => {
    for (const { ref } of expressions(value, mode, shadow)) {
      if (mode === "both" && /^\$(?:today|now|\{(?:today|now)\})$/.test(ref)) continue;
      warnings.push(`${path}: "${ref}" is text, not a date, since the domain sets no clock, as before 1.3: set \`clock:\` to now or a date and time to make it a date. 2.0 will reject it without one.`);
    }
    return value;
  };
  mapDomain(domain, visit);
  for (const task of domain.tasks) mapTask(task, visit);
  return warnings;
}

/** What `validate` rejects about dates in a domain that uses a clock (see clockedDates). */
export function dateProblems(domain: Domain): string[] {
  return usesClock(domain) ? clockedDates(domain).problems : [];
}

/**
 * What `validate` warns about dates: in a domain that sets no clock anywhere, every date expression (see unclockedDates);
 * in one that uses a clock, the ones that can't resolve in the places 1.4 took any string in as text (see clockedDates).
 */
export function dateWarnings(domain: Domain): string[] {
  return usesClock(domain) ? clockedDates(domain).warnings : unclockedDates(domain);
}

/** How to give a place's trials a clock, after "set" or "Set". */
const SET_CLOCK = "`clock:` to now or a date and time, such as `clock: 2026-11-02T09:00`";

/**
 * What `validate` reports about dates in a domain that uses a clock (see usesClock): a malformed expression such as
 * `$today+2h` or `$now+5x`, and any expression in a place whose trials have no clock, since it would stay literal text.
 * Each is a problem, except in the places that resolve since 1.5 (the policy, params' defaults, faults' messages and
 * `reply_includes`), where 1.4 accepted any string: there it stays text, as in 1.4, and is a warning until 2.0.
 * A tool's own param named `today` or `now` is that param, not a date, so it is left alone.
 */
function clockedDates(domain: Domain): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  /** Checks one place's strings. `unclocked` is undefined when every trial the place resolves in has a clock; else what follows "needs a clock". */
  const check =
    (unclocked: string | undefined): Visit =>
    (value, { mode, path, shadow, lenient }) => {
      const found = expressions(value, mode, shadow);
      for (const { ref, name, body } of found) {
        // Any clock tells a well-formed expression from a malformed one.
        const malformed = evaluate(body, "2000-01-01T00:00") === undefined;
        if (!malformed && unclocked === undefined) continue;
        if (!lenient) problems.push(malformed ? `${path}: "${ref}" is not a date: ${MALFORMED[name]}` : `${path}: "${ref}" needs a clock${unclocked}: set ${SET_CLOCK}`);
        else if (malformed) warnings.push(`${path}: "${ref}" is text, not a date, as in 1.4: ${MALFORMED[name]}. 2.0 will reject it.`);
        else warnings.push(`${path}: "${ref}" is text, not a date, as in 1.4: it needs a clock${unclocked}. Set ${SET_CLOCK}, to make it a date; 2.0 will reject it without one.`);
      }
      return value;
    };
  // The domain's own places resolve in every task's trials: without a domain clock, every task needs its own, and
  // with no tasks at all, nothing would give one.
  const without = domain.tasks.filter((t) => writtenClock(domain, t) === undefined).map((t) => t.id);
  const some = without.length > 0 && without.length < domain.tasks.length;
  const domainUnclocked = domain.clock !== undefined || (domain.tasks.length > 0 && without.length === 0) ? undefined : some ? `, and ${without.length === 1 ? "task" : "tasks"} ${without.join(", ")} ${without.length === 1 ? "has" : "have"} none` : "";
  mapDomain(domain, check(domainUnclocked));
  for (const task of domain.tasks) mapTask(task, check(writtenClock(domain, task) === undefined ? "" : undefined));
  return { problems, warnings };
}
