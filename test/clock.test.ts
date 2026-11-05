import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { lintDomain } from "../src/grade/lint.ts";
import { runEpisode } from "../src/run/episode.ts";
import { inputsFingerprint, taskFingerprints } from "../src/run/inputs.ts";
import { regradeSuite, RegradeError } from "../src/run/regrade.ts";
import { runSuite, type SuiteResult } from "../src/run/suite.ts";
import { serveConversations } from "../src/serve/driven.ts";
import { startWorldServer, type WorldServer } from "../src/serve/server.ts";
import { httpAgent } from "../src/sim/http.ts";
import { agentSystemPrompt, userSystemPrompt } from "../src/sim/prompts.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import type { AgentAdapter, AgentContext } from "../src/sim/types.ts";
import { dateOf, describeClock, interpolateDates, localMinute, resolveDates, resolveTrial, trialClock } from "../src/spec/clock.ts";
import { domainWarnings, loadDomain, parseDomain, validateDomain } from "../src/spec/load.ts";
import { DomainSpec, InvariantSpec, TaskSpec, type Domain } from "../src/spec/schema.ts";
import { worldFor } from "../src/world/store.ts";
import { executeTool } from "../src/world/tools.ts";

// A simulation clock (#38): `clock` freezes "now" or reads it when each trial starts, and `$today+2d`, `$now-3h` and
// `${today}` are dates relative to it. Everything that reads the real time here is given a fixed one instead.

/** A fictional carrier desk whose dates are all relative to its clock, in every place a date resolves. */
const YAML_DOMAIN = `
name: clocked-desk
description: Pinecrest Hauling, a (fictional) carrier desk.
clock: 2026-11-02T09:00
policy: Book loads that pick up today or later.
world:
  tables:
    loads:
      key: load_id
      rows:
        - { load_id: L-1, pickup_date: $today+2d, posted_at: $now-90m, status: available }
        - { load_id: L-2, pickup_date: $today-1d, status: available }
    bookings:
      key: booking_id
tools:
  - name: get_load
    description: Look up a load that picks up today or later.
    params: { load_id: { type: string } }
    checks:
      - { table: loads, key: $load_id, where: { pickup_date: { $gte: $today } }, error: "Load \${load_id} picked up before \${today}" }
    ops:
      - { get: loads, key: $load_id }
  - name: list_upcoming
    description: Loads picking up in the next three days.
    ops:
      - { list: loads, where: { pickup_date: { $gte: $today, $lte: $today+3d } } }
  - name: book_load
    description: Book a load.
    params: { load_id: { type: string }, pickup_date: { type: string } }
    ops:
      - { create: bookings, values: { load_id: $load_id, pickup_date: $pickup_date, booked_at: $now, summary: "Booked \${load_id} on \${today}, rep follow-up \${now+1h}" } }
  - name: echo_today
    description: A tool with a param of its own named today.
    params: { today: { type: string } }
    ops:
      - { respond: { got: $today, text: "you said \${today}" } }
invariants:
  - id: no-past-pickup
    description: Never book a pickup date before today.
    never: { tool: book_load, when: { pickup_date: { $lt: $today } } }
  - id: only-upcoming
    description: Book only loads that pick up today or later.
    require: { tool: book_load, table: loads, key_arg: load_id, where: { pickup_date: { $gte: $today } } }
tasks:
  - id: book-upcoming
    user:
      instructions: "You want the load that picks up on \${today+2d}. It is \${now}."
      opening: "Anything picking up \${today+2d}?"
      script: ["Anything picking up \${today+2d}?", "Book it."]
    given:
      rows: { loads: [{ load_id: L-3, pickup_date: $today+1d, status: available }] }
      context: { called_at: $now }
    reference:
      - { tool: book_load, args: { load_id: L-1, pickup_date: $today+2d } }
    events:
      - { after: { tool: get_load }, update: loads, key: L-3, set: { status: booked, booked_on: $today } }
    expect:
      state:
        - { table: bookings, where: { load_id: L-1, pickup_date: $today+2d, booked_at: $now }, count: 1 }
        - { table: loads, key: L-1, fields: { pickup_date: { $gt: $today } } }
      called: [{ tool: book_load, args: { pickup_date: $today+2d } }]
      not_called: [{ tool: book_load, args: { pickup_date: $today-1d } }]
  - id: new-year
    clock: 2026-12-31T23:30
    user: { instructions: "Ask what picks up on \${today+1d}.", script: ["Anything on \${today+1d}?"] }
    expect: { called: [list_upcoming] }
`;

const raw = () => YAML.parse(YAML_DOMAIN) as Record<string, unknown>;
const domainWith = (patch: Record<string, unknown> = {}): Domain => parseDomain({ ...raw(), ...patch });
/** The same, parsed without validate's cross-reference checks: for a domain left without a clock on purpose. */
const unchecked = (patch: Record<string, unknown> = {}): Domain => DomainSpec.parse({ ...raw(), ...patch });
/** A domain with no clock and no dates relative to one. */
const PLAIN = {
  clock: undefined,
  world: { tables: { loads: { key: "load_id", rows: [{ load_id: "L-1", pickup_date: "2026-11-04" }] }, bookings: { key: "booking_id" } } },
  tools: [
    { name: "get_load", description: "Look up a load.", params: { load_id: { type: "string" } }, ops: [{ get: "loads", key: "$load_id" }] },
    { name: "book_load", description: "Book a load.", params: { load_id: { type: "string" }, pickup_date: { type: "string" } }, ops: [{ create: "bookings", values: { load_id: "$load_id", pickup_date: "$pickup_date" } }] },
  ],
  invariants: [],
  tasks: [{ id: "plain", user: { instructions: "Hi.", script: ["Hi."] }, expect: { called: ["get_load"] } }],
};
const CLOCK = "2026-11-02T09:00";
/** 9:00 on Monday, November 2, 2026, on this machine's clock: what `clock: now` reads at that moment. */
const MONDAY = new Date(2026, 10, 2, 9, 0, 41);
const TUESDAY = new Date(2026, 10, 3, 9, 0, 12);

/** Looks L-1 up and books it for the pickup date the tool returned, once per call, saying what it saw. */
function bookingAgent(seen: AgentContext[] = []): AgentAdapter {
  return {
    name: "booker",
    async createSession(ctx) {
      seen.push(ctx);
      let booked = false;
      return {
        async reply(_message, callTool) {
          if (booked) return "Anything else?";
          booked = true;
          const load = (await callTool("get_load", { load_id: "L-1" })).result as { pickup_date: string };
          await callTool("book_load", { load_id: "L-1", pickup_date: load.pickup_date });
          return `Booked L-1 for ${load.pickup_date}.`;
        },
      };
    },
  };
}

describe("date expressions", () => {
  it("are the clock's date and minute, with an offset in days, hours or minutes", () => {
    expect(dateOf("$today", CLOCK)).toBe("2026-11-02");
    expect(dateOf("$today+2d", CLOCK)).toBe("2026-11-04");
    expect(dateOf("$today-1d", CLOCK)).toBe("2026-11-01");
    expect(dateOf("$now", CLOCK)).toBe("2026-11-02T09:00");
    expect(dateOf("$now+90m", CLOCK)).toBe("2026-11-02T10:30");
    expect(dateOf("$now-3h", CLOCK)).toBe("2026-11-02T06:00");
    expect(dateOf("$now+1d", CLOCK)).toBe("2026-11-03T09:00");
    expect(dateOf("$today+0d", CLOCK)).toBe("2026-11-02");
  });

  it("cross month and year ends, leap days and midnight, both ways", () => {
    expect(dateOf("$today+1d", "2026-01-31T09:00")).toBe("2026-02-01");
    expect(dateOf("$today+30d", "2026-01-31T09:00")).toBe("2026-03-02");
    expect(dateOf("$today-2d", "2026-03-01T00:00")).toBe("2026-02-27");
    expect(dateOf("$today+1d", "2028-02-28T12:00")).toBe("2028-02-29");
    expect(dateOf("$today+1d", "2026-12-31T23:59")).toBe("2027-01-01");
    expect(dateOf("$today-1d", "2027-01-01T00:00")).toBe("2026-12-31");
    expect(dateOf("$now+45m", "2026-12-31T23:30")).toBe("2027-01-01T00:15");
    expect(dateOf("$now-1m", "2026-01-01T00:00")).toBe("2025-12-31T23:59");
    expect(dateOf("$now-3h", "2026-11-02T01:00")).toBe("2026-11-01T22:00");
    expect(dateOf("$now+48h", "2026-02-27T10:00")).toBe("2026-03-01T10:00");
  });

  it("count on the wall clock, with no daylight-saving jumps", () => {
    // 2026-03-08 and 2026-03-29 are when the US and the EU spring forward; 2026-11-01 and 2026-10-25 when they fall back.
    expect(dateOf("$now+1h", "2026-03-08T01:30")).toBe("2026-03-08T02:30");
    expect(dateOf("$now+1h", "2026-03-29T01:30")).toBe("2026-03-29T02:30");
    expect(dateOf("$now+1h", "2026-11-01T01:30")).toBe("2026-11-01T02:30");
    expect(dateOf("$now+24h", "2026-10-24T12:00")).toBe("2026-10-25T12:00");
  });

  it("are whole strings in exactly that form: anything else is not one", () => {
    for (const s of ["$today+2h", "$today+2m", "$now+5x", "$today+", "$today+-1d", "$today+1.5d", "$todays", "today", " $today", "$today ", "$Today", "${today}", "$now+1d2h"]) {
      expect(dateOf(s, CLOCK), s).toBeUndefined();
    }
  });

  it("interpolate as ${today+2d} and ${now} inside text, leaving other references and malformed ones as they are", () => {
    expect(interpolateDates("Pickup ${today+2d}, called ${now-15m}, load ${load_id}, ${today+2h}, $today", CLOCK)).toBe(
      "Pickup 2026-11-04, called 2026-11-02T08:45, load ${load_id}, ${today+2h}, $today",
    );
  });
});

describe("clock", () => {
  it("is now, or a date and time to the minute with no time zone; a YAML or JS Date is read as that minute in UTC", () => {
    expect(DomainSpec.parse({ ...raw(), clock: "now" }).clock).toBe("now");
    expect(DomainSpec.parse({ ...raw(), clock: "2026-11-02T09:00" }).clock).toBe("2026-11-02T09:00");
    expect(DomainSpec.parse({ ...raw(), clock: new Date(Date.UTC(2026, 10, 2, 9, 0)) }).clock).toBe("2026-11-02T09:00");
    expect(TaskSpec.parse({ ...(raw().tasks as object[])[0], clock: new Date(Date.UTC(2026, 11, 31, 23, 30)) }).clock).toBe("2026-12-31T23:30");
    expect(DomainSpec.parse({ ...raw(), clock: undefined }).clock).toBeUndefined();
  });

  it("rejects anything else, with what a clock looks like", () => {
    for (const clock of ["2026-11-02", "2026-11-02T9:00", "2026-11-02T09:00:00", "2026-11-02T09:00Z", "2026-02-30T09:00", "2026-11-02T24:00", "2026-11-02T09:60", "tomorrow", "NOW", 20261102, new Date(Number.NaN)]) {
      const r = DomainSpec.safeParse({ ...raw(), clock });
      expect(r.success, String(clock)).toBe(false);
      expect(r.error!.issues[0]!.message).toBe("a clock is now, or a date and time to the minute with no time zone, such as 2026-11-02T09:00");
    }
    expect(TaskSpec.safeParse({ ...(raw().tasks as object[])[0], clock: "2026-11-31T09:00" }).success).toBe(false);
  });

  it("is a trial's task's clock, else its domain's; now is the minute the trial starts on this machine", () => {
    expect(localMinute(MONDAY)).toBe("2026-11-02T09:00");
    expect(localMinute(new Date(2026, 0, 5, 7, 4, 59, 999))).toBe("2026-01-05T07:04");
    expect(trialClock({ clock: "2026-11-02T09:00" }, {}, TUESDAY)).toBe("2026-11-02T09:00");
    expect(trialClock({ clock: "now" }, {}, TUESDAY)).toBe("2026-11-03T09:00");
    expect(trialClock({ clock: "2026-11-02T09:00" }, { clock: "now" }, TUESDAY)).toBe("2026-11-03T09:00");
    expect(trialClock({ clock: "now" }, { clock: "2026-12-31T23:30" }, TUESDAY)).toBe("2026-12-31T23:30");
    expect(trialClock({}, {}, TUESDAY)).toBeUndefined();
    expect(trialClock({}, undefined, TUESDAY)).toBeUndefined();
  });

  it("is told in a fixed en-US form, whatever the machine's locale and time zone", () => {
    expect(describeClock("2026-11-02T09:00")).toBe("Monday, November 2, 2026, 9:00 AM");
    expect(describeClock("2026-11-02T00:05")).toBe("Monday, November 2, 2026, 12:05 AM");
    expect(describeClock("2026-11-02T12:30")).toBe("Monday, November 2, 2026, 12:30 PM");
    expect(describeClock("2027-01-01T13:45")).toBe("Friday, January 1, 2027, 1:45 PM");
    expect(describeClock("2028-02-29T23:59")).toBe("Tuesday, February 29, 2028, 11:59 PM");
  });
});

describe("resolveDates", () => {
  const domain = domainWith();
  const task = domain.tasks[0]!;
  const { domain: d, task: t } = resolveDates(domain, task, CLOCK);

  it("resolves whole values in seed rows and a task's given rows and context", () => {
    expect(d.world.tables.loads!.rows).toEqual([
      { load_id: "L-1", pickup_date: "2026-11-04", posted_at: "2026-11-02T07:30", status: "available" },
      { load_id: "L-2", pickup_date: "2026-11-01", status: "available" },
    ]);
    expect(t.given).toEqual({ rows: { loads: [{ load_id: "L-3", pickup_date: "2026-11-03", status: "available" }] }, context: { called_at: "2026-11-02T09:00" } });
  });

  it("resolves tool ops, checks and where clauses, and interpolates their text, leaving argument references for the call", () => {
    const tool = (name: string) => d.tools.find((x) => x.name === name)!;
    expect(tool("get_load").checks).toEqual([{ table: "loads", key: "$load_id", where: { pickup_date: { $gte: "2026-11-02" } }, error: "Load ${load_id} picked up before 2026-11-02" }]);
    expect(tool("list_upcoming").ops).toEqual([{ list: "loads", where: { pickup_date: { $gte: "2026-11-02", $lte: "2026-11-05" } } }]);
    expect(tool("book_load").ops).toEqual([
      { create: "bookings", values: { load_id: "$load_id", pickup_date: "$pickup_date", booked_at: "2026-11-02T09:00", summary: "Booked ${load_id} on 2026-11-02, rep follow-up 2026-11-02T10:00" } },
    ]);
  });

  it("leaves a tool's own param named today as that param, in its ops and its text", () => {
    const echo = d.tools.find((x) => x.name === "echo_today")!;
    expect(echo.ops).toEqual(domain.tools.find((x) => x.name === "echo_today")!.ops);
    expect(executeTool(echo, worldFor(d, t), { today: "the 4th" })).toEqual({ ok: true, result: { got: "the 4th", text: "you said the 4th" } });
  });

  it("resolves invariants' where and when", () => {
    expect(d.invariants.map((i) => ("never" in i ? i.never.when : "require" in i ? i.require.where : undefined))).toEqual([{ pickup_date: { $lt: "2026-11-02" } }, { pickup_date: { $gte: "2026-11-02" } }]);
    // A max_count's when too.
    const counted = { ...domain, invariants: [InvariantSpec.parse({ id: "one-booking-this-week", description: "x", max_count: { tool: "book_load", max: 1, when: { pickup_date: { $lte: "$today+7d" } } } })] };
    const resolved = resolveDates(counted, counted.tasks[0]!, CLOCK).domain.invariants[0]!;
    expect("max_count" in resolved && resolved.max_count.when).toEqual({ pickup_date: { $lte: "2026-11-09" } });
  });

  it("resolves a task's events, expectations and reference, and interpolates the caller's instructions, opening and script", () => {
    expect(t.events).toEqual([{ after: { tool: "get_load", call: 1 }, update: "loads", key: "L-3", set: { status: "booked", booked_on: "2026-11-02" } }]);
    expect(t.expect.state).toEqual([
      { table: "bookings", where: { load_id: "L-1", pickup_date: "2026-11-04", booked_at: "2026-11-02T09:00" }, count: 1 },
      { table: "loads", key: "L-1", fields: { pickup_date: { $gt: "2026-11-02" } } },
    ]);
    expect(t.expect.called).toEqual([{ tool: "book_load", args: { pickup_date: "2026-11-04" } }]);
    expect(t.expect.not_called).toEqual([{ tool: "book_load", args: { pickup_date: "2026-11-01" } }]);
    expect(t.reference).toEqual([{ tool: "book_load", args: { load_id: "L-1", pickup_date: "2026-11-04" } }]);
    expect(t.user).toEqual({ instructions: "You want the load that picks up on 2026-11-04. It is 2026-11-02T09:00.", opening: "Anything picking up 2026-11-04?", script: ["Anything picking up 2026-11-04?", "Book it."] });
  });

  it("records the clock it resolved with, and leaves the domain and task as written", () => {
    expect(d.clock).toBe(CLOCK);
    expect(domain.world.tables.loads!.rows[0]!.pickup_date).toBe("$today+2d");
    expect(task.user.opening).toBe("Anything picking up ${today+2d}?");
  });

  it("uses a task's own clock for every date in its trials, the domain's included", () => {
    const later = resolveTrial(domain, domain.tasks[1]!, TUESDAY);
    expect(later.clock).toBe("2026-12-31T23:30");
    expect(later.task.user.script).toEqual(["Anything on 2027-01-01?"]);
    expect(later.domain.world.tables.loads!.rows[0]!.pickup_date).toBe("2027-01-02");
  });

  it("changes nothing without a clock", () => {
    const plain = { ...domain, clock: undefined, tasks: domain.tasks.map((x) => ({ ...x, clock: undefined })) };
    const r = resolveTrial(plain, plain.tasks[0]!, MONDAY);
    expect(r.domain).toBe(plain);
    expect(r.task).toBe(plain.tasks[0]);
    expect(r.clock).toBeUndefined();
  });
});

describe("validate", () => {
  const problems = (patch: Record<string, unknown>) => validateDomain(DomainSpec.parse({ ...raw(), ...patch }));
  const NEEDS = "needs a clock: set `clock:` to now or a date and time, such as `clock: 2026-11-02T09:00`";

  it("accepts dates relative to a clock, with no complaint that $today is not a param", () => {
    expect(problems({})).toEqual([]);
    expect(problems({ clock: "now" })).toEqual([]);
  });

  it("keeps $today and $now text in a domain that sets no clock anywhere, as 1.2 did, and warns about each (#475)", () => {
    const tasks = (raw().tasks as Record<string, unknown>[]).map((t) => ({ ...t, clock: undefined }));
    const d = DomainSpec.parse({ ...raw(), clock: undefined, tasks });
    const TEXT = "is text, not a date, since the domain sets no clock, as before 1.3: set `clock:` to now or a date and time to make it a date. 2.0 will reject it without one.";
    // In a tool's ops or checks, $today and ${today} are references to a param the tool doesn't have: an error, as in 1.2.
    expect(validateDomain(d)).toEqual([
      'tools.get_load.checks[0]: "$today" never resolves: tool "get_load" has no param "today"',
      'tools.get_load.checks[0]: "${today}" never resolves: tool "get_load" has no param "today"',
      'tools.list_upcoming.ops[0]: "$today" never resolves: tool "list_upcoming" has no param "today"',
      'tools.book_load.ops[0]: "$now" never resolves: tool "book_load" has no param "now"',
      'tools.book_load.ops[0]: "${today}" never resolves: tool "book_load" has no param "today"',
    ]);
    const warned = domainWarnings(d);
    expect(warned).toContain(`world.tables.loads.rows[0].pickup_date: "$today+2d" ${TEXT}`);
    expect(warned).toContain(`world.tables.loads.rows[0].posted_at: "$now-90m" ${TEXT}`);
    expect(warned).toContain(`tools.book_load.ops[0].values.summary: "\${now+1h}" ${TEXT}`);
    expect(warned).toContain(`invariants.no-past-pickup.never.when.pickup_date.$lt: "$today" ${TEXT}`);
    expect(warned).toContain(`tasks.book-upcoming.user.instructions: "\${today+2d}" ${TEXT}`);
    expect(warned).toContain(`tasks.book-upcoming.given.rows.loads[0].pickup_date: "$today+1d" ${TEXT}`);
    expect(warned).toContain(`tasks.book-upcoming.events[0].set.booked_on: "$today" ${TEXT}`);
    expect(warned).toContain(`tasks.book-upcoming.expect.called[0].args.pickup_date: "$today+2d" ${TEXT}`);
    expect(warned).toContain(`tasks.book-upcoming.reference[0].args.pickup_date: "$today+2d" ${TEXT}`);
    // A malformed one is text too, as in 1.2.
    const rows = [{ load_id: "L-1", pickup_date: "$today+2h" }];
    const odd = DomainSpec.parse({ ...raw(), clock: undefined, tasks, world: { tables: { loads: { key: "load_id", rows }, bookings: { key: "booking_id" } } } });
    expect(domainWarnings(odd)).toContain(`world.tables.loads.rows[0].pickup_date: "$today+2h" ${TEXT}`);
    expect(validateDomain(odd).filter((p) => p.includes("$today+2h"))).toEqual([]);
    // The tool's own param named today needs no clock.
    expect(warned.filter((w) => w.includes("echo_today"))).toEqual([]);
    // Nothing resolves: the trial's world keeps the text, as 1.2's did.
    expect(resolveTrial(d, d.tasks[0]!, MONDAY).domain.world.tables.loads!.rows[0]!.pickup_date).toBe("$today+2d");
  });

  it("rejects $today and $now where a task has no clock, in a domain that uses one", () => {
    // The domain sets none, but one task does: the other task's own places need one.
    const found = problems({ clock: undefined });
    expect(found).toContain(`tasks.book-upcoming.given.rows.loads[0].pickup_date: "$today+1d" ${NEEDS}`);
    expect(found).toContain(`tasks.book-upcoming.user.instructions: "\${today+2d}" ${NEEDS}`);
    expect(found.filter((p) => p.includes("echo_today") || p.includes("never resolves"))).toEqual([]);
  });

  it("names the tasks without a clock when only some tasks have one", () => {
    const found = problems({ clock: undefined });
    expect(found).toContain(`world.tables.loads.rows[0].pickup_date: "$today+2d" needs a clock, and task book-upcoming has none: set \`clock:\` to now or a date and time, such as \`clock: 2026-11-02T09:00\``);
    // The task with its own clock is fine.
    expect(found.filter((p) => p.startsWith("tasks.new-year"))).toEqual([]);
  });

  it("rejects a malformed offset, with a clock or without", () => {
    const rows = [{ load_id: "L-1", pickup_date: "$today+2h", posted_at: "$now+5x", label: "$today+" }];
    const found = problems({ world: { tables: { loads: { key: "load_id", rows }, bookings: { key: "booking_id" } } } });
    expect(found).toEqual([
      'world.tables.loads.rows[0].pickup_date: "$today+2h" is not a date: $today takes an offset in days, such as $today+2d',
      'world.tables.loads.rows[0].posted_at: "$now+5x" is not a date: an offset is a whole number of d, h or m, such as $now+90m or $now-3h',
      'world.tables.loads.rows[0].label: "$today+" is not a date: $today takes an offset in days, such as $today+2d',
    ]);
    const tools = (raw().tools as Record<string, unknown>[]).map((t) => (t.name === "book_load" ? { ...t, ops: [{ respond: { note: "Call back ${now+2x}" } }] } : t));
    expect(problems({ tools })).toEqual(['tools.book_load.ops[0].respond.note: "${now+2x}" is not a date: an offset is a whole number of d, h or m, such as $now+90m or $now-3h']);
  });

  it("still reports a reference to a param that doesn't exist", () => {
    const tools = (raw().tools as Record<string, unknown>[]).map((t) => (t.name === "get_load" ? { ...t, ops: [{ get: "loads", key: "$loadId" }] } : t));
    expect(problems({ tools })).toEqual(['tools.get_load.ops[0]: "$loadId" never resolves: tool "get_load" has no param "loadId"']);
  });
});

describe("dates in the policy, param defaults, fault messages and reply_includes (#465)", () => {
  /** A tool whose optional params default to dates, as a real API's often do, nested ones too. */
  const schedule = (defaults: { from?: string; until?: string; ready?: string } = {}) => ({
    name: "schedule_pickup",
    description: "Schedule a load's pickup window, from today unless the caller says otherwise.",
    params: {
      load_id: { type: "string", description: "Not $today: a description stays as written." },
      pickup_from: { type: "string", required: false, default: defaults.from ?? "$today" },
      window: {
        type: "object",
        required: false,
        default: { until: "$today+3d" },
        properties: {
          until: { type: "string", required: false, default: defaults.until ?? "$today+2d" },
          note: { type: "string", required: false, default: "from ${today}" },
        },
      },
      stops: { type: "array", required: false, items: { type: "object", properties: { ready_at: { type: "string", required: false, default: defaults.ready ?? "$now" } } } },
      kind: { type: "string", required: false, enum: ["$today", "later"] },
    },
    ops: [{ respond: { load_id: "$load_id", from: "$pickup_from", until: "$window.until" } }],
  });
  /** Its own param named today shadows the date, in its defaults as in its ops; now is still a date. */
  const echo = {
    name: "echo_today",
    description: "A tool with a param of its own named today.",
    params: { today: { type: "string", required: false, default: "$today" }, at: { type: "string", required: false, default: "$now" } },
    ops: [{ respond: { got: "$today" } }],
  };
  const tools = (extra = schedule()) => [...(raw().tools as Record<string, unknown>[]).filter((t) => t.name !== "echo_today"), echo, extra];
  const POLICY = "Today is ${today}; cancellations close at ${today+1d} 09:00. A bare $today stays prose.";
  const FAULT = { tool: "get_load", call: 1, error: "rate_limit", message: "Rate limited until ${now+5m}. Try again after $today." };
  const REPLIES = ["your pickup is ${today+2d}", "$today stays", "call back at ${now+2h}"];
  const [first, second] = raw().tasks as Record<string, unknown>[];
  const places = (patch: { policy?: string; extra?: object; fault?: object; reply?: string[]; clock?: string } = {}) => ({
    ...(Object.hasOwn(patch, "clock") ? { clock: patch.clock } : {}),
    policy: patch.policy ?? POLICY,
    tools: tools(patch.extra as ReturnType<typeof schedule>),
    tasks: [{ ...first, faults: [patch.fault ?? FAULT], expect: { ...(first!.expect as object), reply_includes: patch.reply ?? REPLIES } }, second],
  });

  it("resolve at the trial's clock: the policy and fault messages inside text, param defaults as whole strings, nested ones too", () => {
    const domain = domainWith(places());
    const { domain: d, task: t } = resolveDates(domain, domain.tasks[0]!, CLOCK);
    expect(d.policy).toBe("Today is 2026-11-02; cancellations close at 2026-11-03 09:00. A bare $today stays prose.");
    expect(d.tools.find((x) => x.name === "schedule_pickup")!.params).toEqual({
      load_id: { type: "string", required: true, description: "Not $today: a description stays as written." },
      pickup_from: { type: "string", required: false, default: "2026-11-02" },
      window: {
        type: "object",
        required: false,
        default: { until: "2026-11-05" },
        properties: {
          until: { type: "string", required: false, default: "2026-11-04" },
          // A default is a whole value, like a seed field: ${today} inside it stays text.
          note: { type: "string", required: false, default: "from ${today}" },
        },
      },
      stops: { type: "array", required: false, items: { type: "object", required: true, properties: { ready_at: { type: "string", required: false, default: "2026-11-02T09:00" } } } },
      kind: { type: "string", required: false, enum: ["$today", "later"] },
    });
    expect(t.faults).toEqual([{ ...FAULT, message: "Rate limited until 2026-11-02T09:05. Try again after $today." }]);
    // As written: the domain the trial was resolved from keeps its expressions.
    expect(domain.policy).toBe(POLICY);
    expect(domain.tasks[0]!.faults![0]!.message).toBe(FAULT.message);
  });

  it("follow a tool's own param named today in its defaults, as its ops do", () => {
    const domain = domainWith(places());
    const { domain: d } = resolveDates(domain, domain.tasks[0]!, CLOCK);
    expect(d.tools.find((x) => x.name === "echo_today")!.params).toEqual({
      today: { type: "string", required: false, default: "$today" },
      at: { type: "string", required: false, default: "2026-11-02T09:00" },
    });
  });

  it("resolve reply_includes inside text: a bare $today stays, and ${now} is a date and time", () => {
    const domain = domainWith(places());
    expect(resolveDates(domain, domain.tasks[0]!, CLOCK).task.expect.reply_includes).toEqual(["your pickup is 2026-11-04", "$today stays", "call back at 2026-11-02T11:00"]);
  });

  it("reach the agent and the grading in a run: the prompt, the tool schema, a default the agent leaves out, the fault's error, and a reply said in words", async () => {
    const seen: AgentContext[] = [];
    const agent: AgentAdapter = {
      name: "scheduler",
      async createSession(ctx) {
        seen.push(ctx);
        let turns = 0;
        return {
          async reply(_message, callTool) {
            if (turns++ > 0) return "Anything else?";
            await callTool("get_load", { load_id: "L-1" });
            await callTool("schedule_pickup", { load_id: "L-1" });
            return "Your pickup is Wednesday, November 4.";
          },
        };
      },
    };
    const task = { id: "schedule", user: { instructions: "Ask when L-1 picks up.", script: ["When does L-1 pick up?"] }, faults: [FAULT], expect: { called: ["schedule_pickup"], reply_includes: ["Your pickup is ${today+2d}"] } };
    const domain = domainWith({ ...places(), clock: "now", tasks: [task] });
    const monday = await runSuite({ domain, agent, user: scriptedUser(), now: () => MONDAY });
    const trial = monday.tasks[0]!.trials[0]!;
    expect(seen[0]!.system).toContain("Today is 2026-11-02; cancellations close at 2026-11-03 09:00. A bare $today stays prose.");
    const properties = seen[0]!.tools.find((x) => x.name === "schedule_pickup")!.input_schema.properties as Record<string, { default?: unknown }>;
    expect(properties.pickup_from!.default).toBe("2026-11-02");
    const calls = trial.events.flatMap((e) => (e.type === "tool" ? [[e.name, e.ok ? e.result : e.error]] : []));
    expect(calls).toEqual([
      ["get_load", "Rate limited until 2026-11-02T09:05. Try again after $today."],
      ["schedule_pickup", { load_id: "L-1", from: "2026-11-02", until: "2026-11-05" }],
    ]);
    expect(trial.checks.filter((c) => c.kind === "reply")).toEqual([{ id: "reply:Your pickup is 2026-11-04", kind: "reply", passed: true, detail: 'agent said "Your pickup is 2026-11-04"' }]);
    expect(trial.passed).toBe(true);
    // On Tuesday the pickup is Thursday the 5th, so the same words fail, while the fingerprints, of the spec as written, stay.
    const tuesday = await runSuite({ domain, agent, user: scriptedUser(), now: () => TUESDAY });
    expect(tuesday.tasks[0]!.trials[0]!.checks.filter((c) => c.kind === "reply")).toEqual([{ id: "reply:Your pickup is 2026-11-05", kind: "reply", passed: false, detail: 'agent never said "Your pickup is 2026-11-05"' }]);
    expect([tuesday.inputs, tuesday.tasks[0]!.inputs, tuesday.tasks[0]!.grading]).toEqual([monday.inputs, monday.tasks[0]!.inputs, monday.tasks[0]!.grading]);
    // A regrade the next day resolves them with the trial's recorded clock, so it gives the same verdict.
    const stored = JSON.parse(JSON.stringify(monday)) as SuiteResult;
    expect(regradeSuite(domain, stored).tasks[0]!.trials[0]!.passed).toBe(true);
  });

  describe("validate", () => {
    const problems = (patch: Record<string, unknown>) => validateDomain(DomainSpec.parse({ ...raw(), ...patch }));
    const NEEDS = "needs a clock: set `clock:` to now or a date and time, such as `clock: 2026-11-02T09:00`";
    const malformed = places({
      policy: "Today is ${today+2h}.",
      extra: schedule({ from: "$today+2h", until: "$now+5x", ready: "$now-" }),
      fault: { ...FAULT, message: "Retry after ${now+5x}" },
      reply: ["your pickup is ${today+1x}"],
    });

    it("accepts them with a clock, and a tool's own param named today needs none", () => {
      expect(problems(places())).toEqual([]);
    });

    it("reports a malformed date in each place, at its path", () => {
      expect(problems(malformed)).toEqual([
        'policy: "${today+2h}" is not a date: $today takes an offset in days, such as $today+2d',
        'tools.schedule_pickup.params.pickup_from.default: "$today+2h" is not a date: $today takes an offset in days, such as $today+2d',
        'tools.schedule_pickup.params.window.properties.until.default: "$now+5x" is not a date: an offset is a whole number of d, h or m, such as $now+90m or $now-3h',
        'tools.schedule_pickup.params.stops.items.properties.ready_at.default: "$now-" is not a date: an offset is a whole number of d, h or m, such as $now+90m or $now-3h',
        'tasks.book-upcoming.faults[0].message: "${now+5x}" is not a date: an offset is a whole number of d, h or m, such as $now+90m or $now-3h',
        'tasks.book-upcoming.expect.reply_includes[0]: "${today+1x}" is not a date: $today takes an offset in days, such as $today+2d',
      ]);
    });

    it("rejects each where a task has no clock, in a domain that uses one", () => {
      const found = problems(places({ clock: undefined }));
      const SOME = "needs a clock, and task book-upcoming has none: set `clock:` to now or a date and time, such as `clock: 2026-11-02T09:00`";
      expect(found).toContain(`policy: "\${today}" ${SOME}`);
      expect(found).toContain(`tools.schedule_pickup.params.pickup_from.default: "$today" ${SOME}`);
      expect(found).toContain(`tools.schedule_pickup.params.window.default.until: "$today+3d" ${SOME}`);
      expect(found).toContain(`tasks.book-upcoming.faults[0].message: "\${now+5m}" ${NEEDS}`);
      expect(found).toContain(`tasks.book-upcoming.expect.reply_includes[0]: "\${today+2d}" ${NEEDS}`);
      expect(found.filter((p) => p.includes("echo_today.params.today") || p.includes('"$today stays"'))).toEqual([]);
    });

    it("keeps them text in a domain that sets no clock anywhere, and warns about each", () => {
      const tasks = (places().tasks as Record<string, unknown>[]).map((t) => ({ ...t, clock: undefined }));
      const d = DomainSpec.parse({ ...raw(), ...places({ clock: undefined }), tasks });
      const TEXT = "is text, not a date, since the domain sets no clock, as before 1.3: set `clock:` to now or a date and time to make it a date. 2.0 will reject it without one.";
      const warned = domainWarnings(d);
      expect(warned).toContain(`policy: "\${today}" ${TEXT}`);
      expect(warned).toContain(`policy: "\${today+1d}" ${TEXT}`);
      // A default is a value, not a reference to a param, so it is warned about like a seed field.
      expect(warned).toContain(`tools.schedule_pickup.params.pickup_from.default: "$today" ${TEXT}`);
      expect(warned).toContain(`tools.schedule_pickup.params.stops.items.properties.ready_at.default: "$now" ${TEXT}`);
      expect(warned).toContain(`tools.echo_today.params.at.default: "$now" ${TEXT}`);
      expect(warned).toContain(`tasks.book-upcoming.faults[0].message: "\${now+5m}" ${TEXT}`);
      expect(warned).toContain(`tasks.book-upcoming.expect.reply_includes[0]: "\${today+2d}" ${TEXT}`);
      expect(warned.filter((w) => w.includes("echo_today.params.today") || w.includes("$today stays") || w.includes("description"))).toEqual([]);
      expect(validateDomain(d).filter((p) => /^(policy|tools\.\w+\.params|tasks\.[\w-]+\.(faults|expect\.reply_includes))/.test(p))).toEqual([]);
      // Nothing resolves: the trial keeps the text.
      const trial = resolveTrial(d, d.tasks[0]!, MONDAY);
      expect([trial.domain.policy, trial.task.faults![0]!.message, trial.task.expect.reply_includes[0]]).toEqual([POLICY, FAULT.message, REPLIES[0]]);
    });
  });
});

describe("who is told the time", () => {
  const LINE = "It is now Monday, November 2, 2026, 9:00 AM.";

  it("the default agent prompt and the caller's prompt each say it, in one line", () => {
    const domain = domainWith();
    const agent = agentSystemPrompt(domain);
    expect(agent.split("\n").filter((l) => l === LINE)).toHaveLength(1);
    expect(agent.split("\n").indexOf(LINE)).toBeLessThan(agent.split("\n").indexOf("<policy>"));
    const caller = userSystemPrompt(domain, domain.tasks[0]!);
    expect(caller.split("\n").filter((l) => l === LINE)).toHaveLength(1);
  });

  it("neither prompt mentions a time without a clock, and a clock of now is told once the trial reads it", () => {
    const plain = domainWith(PLAIN);
    expect(agentSystemPrompt(plain)).not.toContain("It is now");
    expect(userSystemPrompt(plain, plain.tasks[0]!)).not.toContain("It is now");
    const live = domainWith({ clock: "now" });
    expect(agentSystemPrompt(live)).not.toContain("It is now");
    const { domain, task } = resolveTrial(live, live.tasks[0]!, TUESDAY);
    expect(agentSystemPrompt(domain, task)).toContain("It is now Tuesday, November 3, 2026, 9:00 AM.");
    expect(userSystemPrompt(domain, task)).toContain("It is now Tuesday, November 3, 2026, 9:00 AM.");
  });

  it("an agent gets the trial's clock as ctx.now, and its world and prompt are resolved with it", async () => {
    const seen: AgentContext[] = [];
    const domain = domainWith({ clock: "now" });
    const r = await runEpisode({ domain, task: domain.tasks[0]!, agent: bookingAgent(seen), user: scriptedUser(), trial: 0, now: () => MONDAY });
    expect(seen[0]!.now).toBe(CLOCK);
    expect(seen[0]!.system).toContain(LINE);
    expect(seen[0]!.context).toEqual({ called_at: CLOCK });
    expect(r.events.find((e) => e.type === "user")).toEqual({ type: "user", text: "Anything picking up 2026-11-04?" });
    const plain = domainWith(PLAIN);
    seen.length = 0;
    const p = await runEpisode({ domain: plain, task: plain.tasks[0]!, agent: bookingAgent(seen), user: scriptedUser(), trial: 0, now: () => MONDAY });
    expect("now" in seen[0]!).toBe(false);
    expect("clock" in p).toBe(false);
  });

  describe("an HTTP agent", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("gets now in every step's request, and none without a clock", async () => {
      const bodies: Record<string, unknown>[] = [];
      const replies = [{ tool_calls: [{ id: "c1", name: "get_load", arguments: { load_id: "L-1" } }] }, { reply: "It picks up on the 4th." }, { reply: "Hi." }];
      vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify(replies.shift()), { status: 200 });
      });
      const domain = domainWith();
      const clocked = await httpAgent("http://agent.local/step").createSession({ domain, system: "s", tools: [], sessionId: "t#0", now: CLOCK });
      await clocked.reply("Hi", async () => ({ ok: true, result: {} }));
      const plain = await httpAgent("http://agent.local/step").createSession({ domain, system: "s", tools: [], sessionId: "u#0" });
      await plain.reply("Hi", async () => ({ ok: true, result: {} }));
      expect(bodies.map((b) => b.now)).toEqual([CLOCK, CLOCK, undefined]);
      expect("now" in bodies[2]!).toBe(false);
    });
  });
});

describe("a run with a clock", () => {
  it("grades every trial against its resolved dates, and records its clock", async () => {
    const domain = domainWith({ tasks: [(raw().tasks as object[])[0]] });
    const r = await runSuite({ domain, agent: bookingAgent(), user: scriptedUser(), now: () => MONDAY });
    const trial = r.tasks[0]!.trials[0]!;
    expect(trial.clock).toBe(CLOCK);
    expect(trial.passed).toBe(true);
    expect(trial.changes.find((c) => c.table === "bookings")!.after).toMatchObject({ load_id: "L-1", pickup_date: "2026-11-04", booked_at: CLOCK });
    // The task's event fired after get_load, with its date resolved too.
    expect(trial.changes.find((c) => c.table === "loads")!.after).toMatchObject({ load_id: "L-3", booked_on: "2026-11-02" });
  });

  it("catches a booking in the past through invariants resolved with the clock", async () => {
    const careless: AgentAdapter = {
      name: "careless",
      async createSession() {
        let turns = 0;
        return {
          async reply(_m, callTool) {
            if (turns++ === 0) await callTool("book_load", { load_id: "L-2", pickup_date: "2026-11-01" });
            return "Done.";
          },
        };
      },
    };
    const domain = domainWith({ tasks: [(raw().tasks as object[])[0]] });
    const trial = (await runSuite({ domain, agent: careless, user: scriptedUser(), now: () => MONDAY })).tasks[0]!.trials[0]!;
    expect(trial.passed).toBe(false);
    expect(trial.violations.map((v) => v.invariant)).toEqual(["no-past-pickup", "only-upcoming"]);
    expect(trial.checks.filter((c) => !c.passed).map((c) => c.id)).toContain('not_called:book_load(pickup_date="2026-11-01")');
  });

  it("with clock: now, starts each trial at the minute it starts, and keeps the run's fingerprints from day to day", async () => {
    const domain = domainWith({ clock: "now", tasks: [(raw().tasks as object[])[0]] });
    const monday = await runSuite({ domain, agent: bookingAgent(), user: scriptedUser(), now: () => MONDAY });
    const tuesday = await runSuite({ domain, agent: bookingAgent(), user: scriptedUser(), now: () => TUESDAY });
    expect(monday.tasks[0]!.trials[0]!.clock).toBe("2026-11-02T09:00");
    expect(tuesday.tasks[0]!.trials[0]!.clock).toBe("2026-11-03T09:00");
    expect(tuesday.tasks[0]!.trials[0]!.changes.find((c) => c.table === "bookings")!.after).toMatchObject({ pickup_date: "2026-11-05" });
    expect([monday.tasks[0]!.trials[0]!.passed, tuesday.tasks[0]!.trials[0]!.passed]).toEqual([true, true]);
    expect(tuesday.inputs).toBe(monday.inputs);
    expect([tuesday.tasks[0]!.inputs, tuesday.tasks[0]!.grading]).toEqual([monday.tasks[0]!.inputs, monday.tasks[0]!.grading]);
  });

  it("changes the fingerprints when a clock is added or changed", () => {
    const ids = ["book-upcoming"];
    const plain = unchecked({ clock: undefined, tasks: [(raw().tasks as object[])[0]] });
    const prints = (d: Domain) => [inputsFingerprint(d, ids, "scripted"), taskFingerprints(d, d.tasks[0]!, "scripted").inputs].join();
    const each = [plain, { ...plain, clock: "now" }, { ...plain, clock: CLOCK }, { ...plain, clock: "2026-11-03T09:00" }].map(prints);
    expect(new Set(each)).toHaveLength(4);
    // A task's own clock counts as the domain's does.
    const own = { ...plain, tasks: [{ ...plain.tasks[0]!, clock: "now" }] };
    expect(prints(own)).toBe(each[1]);
  });
});

describe("regrade", () => {
  const stored = (r: SuiteResult) => JSON.parse(JSON.stringify(r)) as SuiteResult;

  it("resolves a clock: now domain with each trial's recorded clock, so a regrade the next day gives the same verdicts", async () => {
    const domain = domainWith({ clock: "now", tasks: [(raw().tasks as object[])[0]] });
    const run = stored(await runSuite({ domain, agent: bookingAgent(), user: scriptedUser(), k: 2, now: () => MONDAY }));
    expect(run.tasks[0]!.trials.map((t) => [t.clock, t.passed])).toEqual([[CLOCK, true], [CLOCK, true]]);
    // The real time is not Monday 9:00, so get_load would return another pickup date if regrade resolved with it.
    expect({ ...regradeSuite(domain, run), sandtable: run.sandtable }).toEqual(run);
  });

  it("uses a fixed clock for trials that recorded none, and refuses clock: now without one", async () => {
    const domain = domainWith({ tasks: [(raw().tasks as object[])[0]] });
    const run = stored(await runSuite({ domain, agent: bookingAgent(), user: scriptedUser(), now: () => MONDAY }));
    const unclocked = (r: SuiteResult) => ({ ...r, tasks: r.tasks.map((t) => ({ ...t, trials: t.trials.map(({ clock: _, ...trial }) => trial) })) }) as SuiteResult;
    const regraded = regradeSuite(domain, unclocked(run));
    expect(regraded.tasks[0]!.trials.map((t) => [t.clock, t.passed])).toEqual([[CLOCK, true]]);

    const live = domainWith({ clock: "now", tasks: [(raw().tasks as object[])[0]] });
    const liveRun = stored(await runSuite({ domain: live, agent: bookingAgent(), user: scriptedUser(), now: () => MONDAY }));
    expect(() => regradeSuite(live, unclocked(liveRun))).toThrow(RegradeError);
    expect(() => regradeSuite(live, unclocked(liveRun))).toThrow(
      "task book-upcoming's clock is now, and its trials record no clock: there is no telling what the time was when they ran, so their dates can't be resolved again",
    );
    // A clock sandtable didn't write, as in a results.json edited by hand, is refused rather than read.
    const edited = { ...liveRun, tasks: liveRun.tasks.map((t) => ({ ...t, trials: t.trials.map((trial) => ({ ...trial, clock: "tomorrow" })) })) } as SuiteResult;
    expect(() => regradeSuite(live, edited)).toThrow('trial 0 of task book-upcoming records the clock "tomorrow", which isn\'t a date and time such as 2026-11-02T09:00');
  });
});

describe("lint", () => {
  it("resolves each task with the domain's clock, or with the current minute for now", () => {
    const fixed = lintDomain(domainWith());
    expect(fixed.tasks[0]).toMatchObject({ id: "book-upcoming", ready: true, solvable: true, errors: [] });
    const live = domainWith({ clock: "now" });
    for (const now of [MONDAY, TUESDAY, undefined]) {
      expect(lintDomain(live, now ? { now } : {}).tasks[0], String(now)).toMatchObject({ solvable: true, errors: [] });
    }
  });

  it("finds a task whose relative seed can't satisfy it", () => {
    // L-2 picked up yesterday, so the reference's booking of it breaks the rules.
    const tasks = [{ ...(raw().tasks as Record<string, unknown>[])[0], reference: [{ tool: "book_load", args: { load_id: "L-2", pickup_date: "$today-1d" } }] }];
    const report = lintDomain(domainWith({ clock: "now", tasks }), { now: MONDAY });
    expect(report.tasks[0]!.solvable).toBe(false);
  });
});

describe("the bundled examples", () => {
  it("set no clock: their policies state the date, and their prompts and inputs stay as they were", async () => {
    for (const dir of ["examples/freight", "examples/clinic"]) {
      const domain = await loadDomain(dir);
      expect(domain.clock, dir).toBeUndefined();
      expect(domain.policy, dir).toContain("Today is Monday, November 2, 2026, and it is 9:00 a.m.");
      expect(JSON.stringify(domain), dir).not.toMatch(/\$\{?(today|now)\b/);
      expect(agentSystemPrompt(domain), dir).not.toContain("It is now");
    }
  });
});

describe("serving the world", () => {
  const servers: WorldServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.stop()));
  });
  const post = async (url: string, body: unknown) => (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

  it("run --serve: a trial's world on the server is resolved with its clock", async () => {
    const domain = domainWith({ clock: "now", tasks: [(raw().tasks as object[])[0]] });
    const server = await startWorldServer(domain, { port: 0 });
    servers.push(server);
    const overHttp: AgentAdapter = {
      name: "over-http",
      async createSession(ctx) {
        let turns = 0;
        return {
          async reply() {
            if (turns++ > 0) return "Anything else?";
            const load = (await post(`${ctx.world!.url}/tools/get_load`, { load_id: "L-1" })) as { pickup_date: string };
            await post(`${ctx.world!.url}/tools/book_load`, { load_id: "L-1", pickup_date: load.pickup_date });
            return `Booked for ${load.pickup_date}.`;
          },
        };
      },
    };
    const trial = (await runSuite({ domain, agent: overHttp, user: scriptedUser(), server, now: () => TUESDAY })).tasks[0]!.trials[0]!;
    expect(trial.clock).toBe("2026-11-03T09:00");
    expect(trial.events.find((e) => e.type === "agent")).toMatchObject({ text: "Booked for 2026-11-05." });
    expect(trial.passed).toBe(true);
  });

  it("sandtable serve: a session's world is resolved when it opens, and its trial records the clock", async () => {
    const domain = domainWith({ clock: "now", tasks: [(raw().tasks as object[])[0]] });
    const served = await serveConversations(domain, { port: 0, label: "platform", now: () => TUESDAY });
    servers.push(served.server);
    const s = (await post(`${served.server.url}/sessions`, { task: "book-upcoming" })) as { id: string; url: string };
    const load = (await post(`${s.url}/tools/get_load`, { load_id: "L-1" })) as { pickup_date: string };
    expect(load.pickup_date).toBe("2026-11-05");
    await post(`${s.url}/tools/book_load`, { load_id: "L-1", pickup_date: load.pickup_date });
    expect(await post(`${served.server.url}/sessions/${s.id}/end`, { transcript: [{ role: "agent", text: "Booked." }] })).toMatchObject({ passed: true });
    expect(served.result()!.tasks[0]!.trials[0]!.clock).toBe("2026-11-03T09:00");
  });
});
