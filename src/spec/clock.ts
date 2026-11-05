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

/** Called with every string in a place a date resolves: returns what the string becomes. */
type Visit = (value: string, at: { mode: Mode; path: string; shadow: ReadonlySet<string> }) => string;

function walk<T>(value: T, mode: Mode, path: string, visit: Visit, shadow: ReadonlySet<string> = NONE): T {
  if (typeof value === "string") return visit(value, { mode, path, shadow }) as T;
  if (Array.isArray(value)) return value.map((v, i) => walk(v, mode, `${path}[${i}]`, visit, shadow)) as T;
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, mode, `${path}.${k}`, visit, shadow)])) as T;
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
    ...(p.default !== undefined ? { default: walk(p.default, "value", `${at}.default`, visit, shadow) } : {}),
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
    policy: walk(domain.policy, "text", "policy", visit),
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
    ...(task.faults ? { faults: task.faults.map((f, i) => (f.message === undefined ? f : { ...f, message: walk(f.message, "text", `${at}.faults[${i}].message`, visit) })) } : {}),
    ...(task.reference ? { reference: task.reference.map((c, i) => ({ ...c, args: walk(c.args, "value", `${at}.reference[${i}].args`, visit) })) } : {}),
    expect: {
      ...task.expect,
      state: walk(task.expect.state, "value", `${at}.expect.state`, visit),
      called: walk(task.expect.called, "value", `${at}.expect.called`, visit),
      not_called: walk(task.expect.not_called, "value", `${at}.expect.not_called`, visit),
      reply_includes: walk(task.expect.reply_includes, "text", `${at}.expect.reply_includes`, visit),
    },
  };
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
 * The domain and task with every date expression resolved at `clock`, and `clock` recorded as the clock of both, so
 * the prompts tell it. The domain's `tasks` stay as written: a trial reads only its own task.
 */
export function resolveDates(domain: Domain, task: Task, clock: string): { domain: Domain; task: Task } {
  const visit = resolver(clock);
  return { domain: { ...mapDomain(domain, visit), clock }, task: { ...mapTask(task, visit), ...(task.clock !== undefined ? { clock } : {}) } };
}

/**
 * What one trial of `task` runs on: the domain and task with their dates resolved at the trial's clock, read from `now`
 * for `clock: now`, and that clock. Without a clock, the domain and task themselves, unchanged.
 */
export function resolveTrial(domain: Domain, task: Task, now: Date = new Date()): { domain: Domain; task: Task; clock?: string } {
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
export function unclockedDates(domain: Domain): string[] {
  if (usesClock(domain)) return [];
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

/**
 * What `validate` reports about dates in a domain that uses a clock (see usesClock): a malformed expression such as
 * `$today+2h` or `$now+5x`, and any expression in a place whose trials have no clock, since it would stay literal text.
 * A tool's own param named `today` or `now` is that param, not a date, so it is left alone.
 */
export function dateProblems(domain: Domain): string[] {
  if (!usesClock(domain)) return [];
  const problems: string[] = [];
  /** Checks one place's strings. `unclocked` is undefined when every trial the place resolves in has a clock; else what follows "needs a clock". */
  const check =
    (unclocked: string | undefined): Visit =>
    (value, { mode, path, shadow }) => {
      const found = expressions(value, mode, shadow);
      for (const { ref, name, body } of found) {
        // Any clock tells a well-formed expression from a malformed one.
        if (evaluate(body, "2000-01-01T00:00") === undefined) problems.push(`${path}: "${ref}" is not a date: ${MALFORMED[name]}`);
        else if (unclocked !== undefined) problems.push(`${path}: "${ref}" needs a clock${unclocked}: set \`clock:\` to now or a date and time, such as \`clock: 2026-11-02T09:00\``);
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
  return problems;
}
