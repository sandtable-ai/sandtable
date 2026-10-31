import path from "node:path";
import { describe, expect, it } from "vitest";
import { lintDomain } from "../src/grade/lint.ts";
import { renderHtml } from "../src/report/html.ts";
import { runEpisode } from "../src/run/episode.ts";
import { inputsFingerprint, taskFingerprints } from "../src/run/inputs.ts";
import { regradeSuite, RegradeError } from "../src/run/regrade.ts";
import { runSuite } from "../src/run/suite.ts";
import { createToolRunner } from "../src/run/tool-runner.ts";
import { freightScriptedAgent } from "../src/demo/freight-agents.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import type { AgentAdapter, CallTool } from "../src/sim/types.ts";
import { loadDomain, validateDomain } from "../src/spec/load.ts";
import { FaultSpec, TaskSpec, type Domain, type Fault, type Task, type TaskEvent } from "../src/spec/schema.ts";
import { worldFor } from "../src/world/store.ts";

// Task faults and events (#15): injected tool failures, and changes someone else makes to the world mid-call.

const example = path.resolve("examples/freight");
const user = { instructions: "You are Dana, MC 100101. You want L-1001.", script: ["MC 100101, I want L-1001."] };
const BOOK = { load_id: "L-1001", mc_number: "100101", rate: 2100 };

function task(extra: Partial<Task> = {}): Task {
  return TaskSpec.parse({ id: "t", user, expect: { state: [{ table: "bookings", count: 1 }] }, ...extra });
}

async function domainWith(...tasks: Task[]): Promise<Domain> {
  return { ...(await loadDomain(example)), tasks };
}

/** A runner on a fresh world for one task, as live runs, lint and regrade make it. */
function runnerFor(domain: Domain, t: Task) {
  const world = worldFor(domain, t);
  return { world, runner: createToolRunner(domain, world, undefined, t) };
}

/** An agent that makes the given calls in order on its first turn and says the outcomes. */
function callingAgent(calls: [string, unknown][]): AgentAdapter {
  return {
    name: "calls",
    async createSession() {
      return {
        async reply(_text: string, callTool: CallTool) {
          const outs = [];
          for (const [name, args] of calls) outs.push(await callTool(name, args));
          return outs.map((o) => (o.ok ? "ok" : o.error)).join("; ");
        },
      };
    },
  };
}

describe("faults: the spec", () => {
  it("takes an error, a latency or both, and each option only with the error it belongs to", () => {
    const ok = (f: unknown) => FaultSpec.safeParse(f).success;
    expect(ok({ tool: "book_load", error: "timeout" })).toBe(true);
    expect(ok({ tool: "book_load", latency_ms: 500 })).toBe(true);
    expect(ok({ tool: "book_load", call: [1, 3], error: "server_error", status: 502, after_commit: true, latency_ms: 10, message: "gateway" })).toBe(true);
    expect(ok({ tool: "search_loads", error: "rate_limit", retry_after: 2 })).toBe(true);
    const why = (f: unknown) => FaultSpec.safeParse(f).error?.issues.map((i) => i.message).join("; ");
    expect(why({ tool: "book_load" })).toMatch(/needs an error, a latency_ms, or both/);
    expect(why({ tool: "book_load", error: "timeout", status: 502 })).toMatch(/status is for error: server_error/);
    expect(why({ tool: "book_load", error: "timeout", retry_after: 1 })).toMatch(/retry_after is for error: rate_limit/);
    expect(why({ tool: "book_load", error: "rate_limit", after_commit: true })).toMatch(/after_commit is for a timeout or a server_error/);
    expect(why({ tool: "book_load", latency_ms: 5, after_commit: true })).toMatch(/after_commit/);
    expect(why({ tool: "book_load", latency_ms: 5, message: "slow" })).toMatch(/message is the text of an error/);
    expect(why({ tool: "book_load", error: "flaky" })).toBeDefined();
    expect(why({ tool: "book_load", error: "timeout", call: 0 })).toBeDefined();
    expect(why({ tool: "book_load", latency_ms: 60_001 })).toBeDefined();
    expect(TaskSpec.safeParse({ id: "t", user, expect: {}, faults: [] }).success).toBe(false);
    // A wrong call number or an event that is both an update and a create says what the key takes.
    expect(why({ tool: "book_load", error: "timeout", call: 1.5 })).toBe("call is a call number, 1 or more, or a list of them");
    const event = (e: unknown) => TaskSpec.safeParse({ id: "t", user, expect: {}, events: [e] }).error?.issues.map((i) => i.message).join("; ");
    expect(event({ after: { tool: "get_load" }, update: "loads", key: "L-1", set: {}, create: "loads", values: {} })).toBe("an event has after, and either update with key and set, or create with values");
  });

  it("validate names an unknown tool or table, an update of a row the task doesn't have, and a created key that exists", async () => {
    const problems = (t: Task) => validateDomain({ ...d, tasks: [t] });
    const d = await loadDomain(example);
    expect(problems(task({ faults: [{ tool: "book_lode", error: "timeout" } as Fault] }))).toEqual([expect.stringMatching(/tasks\.t\.faults\[0\].*unknown tool "book_lode"/)]);
    const ev = (e: unknown) => problems(task({ events: [e as TaskEvent] }));
    expect(ev({ after: { tool: "search_loads", call: 1 }, update: "loads", key: "L-1001", set: { status: "booked" } })).toEqual([]);
    expect(ev({ after: { tool: "serch_loads", call: 1 }, update: "loads", key: "L-1001", set: {} })).toEqual([expect.stringMatching(/events\[0\].*unknown tool "serch_loads"/)]);
    expect(ev({ after: { tool: "search_loads", call: 1 }, update: "lods", key: "L-1001", set: {} })).toEqual([expect.stringMatching(/events\[0\]: unknown table "lods"/)]);
    expect(ev({ after: { tool: "search_loads", call: 1 }, update: "loads", key: "L-9999", set: {} })).toEqual([expect.stringMatching(/events\[0\]: loads L-9999 is not in the task's world/)]);
    expect(ev({ after: { tool: "search_loads", call: 1 }, create: "loads", values: { load_id: "L-1001" } })).toEqual([expect.stringMatching(/events\[0\]: loads L-1001 already exists/)]);
    // A row the task's given.rows add, or an earlier event after the same call creates, can be updated.
    const created = { after: { tool: "search_loads", call: 1 }, create: "loads", values: { load_id: "L-1099", status: "available" } } as TaskEvent;
    const update = { after: { tool: "get_load", call: 1 }, update: "loads", key: "L-1099", set: { status: "booked" } } as TaskEvent;
    expect(problems(task({ events: [created, update] }))).toEqual([expect.stringMatching(/events\[1\]: loads L-1099 is created by an event after search_loads call 1, which may not have fired yet after get_load call 1/)]);
    expect(problems(task({ given: { rows: { loads: [{ load_id: "L-1099", status: "available" }] } }, events: [update] }))).toEqual([]);
    // Events fire in the order the calls come, not in spec order: an update can't count on a row created after another call.
    const later = { ...update, after: { tool: "search_loads", call: 2 } };
    expect(problems(task({ events: [created, later] }))).toEqual([expect.stringMatching(/events\[1\]: loads L-1099 is created by an event after search_loads call 1, which may not have fired yet after search_loads call 2/)]);
    const same = { ...update, after: { tool: "search_loads", call: 1 } };
    expect(problems(task({ events: [created, same] }))).toEqual([]);
    expect(problems(task({ events: [created, { ...created }] }))).toEqual([expect.stringMatching(/events\[1\]: loads L-1099 already exists/)]);
    expect(problems(task({ events: [update] }))).toEqual([expect.stringMatching(/events\[0\]: loads L-1099 is not in the task's world/)]);
  });
});

describe("faults: the tool runner", () => {
  it("fails the call it names, counting only calls that reach the tool, and changes nothing without after_commit", async () => {
    const t = task({ faults: [{ tool: "book_load", call: 2, error: "timeout" }] });
    const { world, runner } = runnerFor(await domainWith(t), t);
    // Invalid arguments never reach the API, so they don't count.
    expect(runner.call("book_load", { load_id: "L-1001" }).error).toMatch(/missing required argument/);
    expect(runner.call("book_load", { ...BOOK, load_id: "L-1003" })).toEqual({ ok: false, result: undefined, error: "Load L-1003 is not available" });
    expect(runner.call("book_load", BOOK)).toEqual({ ok: false, result: undefined, error: "book_load timed out: no response from the server" });
    expect(world.list("bookings")).toEqual([]);
    expect(runner.calls.at(-1)!.fault).toEqual({ error: "timeout", status: 504 });
    expect(runner.call("book_load", BOOK).ok).toBe(true);
    expect(runner.faultsHit).toEqual(new Set([0]));
  });

  it("with after_commit, lets the write land and still shows the error, recording whether it landed", async () => {
    const t = task({ faults: [{ tool: "book_load", error: "timeout", after_commit: true }] });
    const { world, runner } = runnerFor(await domainWith(t), t);
    expect(runner.call("book_load", BOOK).ok).toBe(false);
    expect(world.list("bookings")).toHaveLength(1);
    expect(world.get("loads", "L-1001")!.status).toBe("booked");
    expect(runner.calls.at(-1)!.fault).toEqual({ error: "timeout", status: 504, committed: true });
    // The retry hits the fault too (no call: every call), and its check fails: nothing landed.
    expect(runner.call("book_load", BOOK).ok).toBe(false);
    expect(runner.calls.at(-1)!.fault).toEqual({ error: "timeout", status: 504, committed: false });
    expect(world.list("bookings")).toHaveLength(1);
  });

  it("says what a rate limit, a server error and a custom message say, and lets a latency-only fault succeed", async () => {
    const t = task({
      faults: [
        { tool: "search_loads", call: [1, 2], error: "rate_limit", retry_after: 2 },
        { tool: "search_loads", call: 2, error: "server_error" },
        { tool: "get_load", call: 1, error: "server_error", status: 502 },
        { tool: "get_load", call: 2, error: "server_error", message: "TMS gateway error" },
        { tool: "verify_carrier", latency_ms: 25 },
      ],
    });
    const { runner } = runnerFor(await domainWith(t), t);
    expect(runner.call("search_loads", { origin: "Dallas" }).error).toBe("429 Too Many Requests: rate limit exceeded, retry after 2 seconds");
    // The first fault that names a call wins.
    expect(runner.calls.at(-1)!.fault).toEqual({ error: "rate_limit", status: 429, retryAfter: 2 });
    expect(runner.call("search_loads", { origin: "Dallas" }).error).toMatch(/^429 /);
    expect(runner.call("search_loads", { origin: "Dallas" }).ok).toBe(true);
    expect(runner.call("get_load", { load_id: "L-1001" }).error).toBe("502 Bad Gateway: the server could not handle the request");
    expect(runner.call("get_load", { load_id: "L-1001" }).error).toBe("TMS gateway error");
    expect(runner.calls.at(-1)!.fault).toEqual({ error: "server_error", status: 503 });
    const verified = runner.call("verify_carrier", { mc_number: "100101" });
    expect(verified.ok).toBe(true);
    expect(runner.calls.at(-1)!.fault).toEqual({ latencyMs: 25 });
    expect(runner.faultsHit).toEqual(new Set([0, 2, 3, 4]));
  });

  it("checks invariants on a faulted call, and counts it as failed for before", async () => {
    const t = task({ faults: [{ tool: "verify_carrier", call: 1, error: "timeout" }] });
    const { runner } = runnerFor(await domainWith(t), t);
    runner.call("verify_carrier", { mc_number: "100101" });
    runner.call("book_load", BOOK);
    // The agent never saw the carrier, so booking breaks verify-before-book.
    expect(runner.violations.map((v) => v.invariant)).toContain("verify-before-book");
  });

  it("applies events right after the call they follow, whether it succeeded or not, and records the change", async () => {
    const t = task({
      events: [
        { after: { tool: "search_loads", call: 1 }, update: "loads", key: "L-1001", set: { status: "booked" } },
        { after: { tool: "get_load", call: 2 }, create: "loads", values: { load_id: "L-1099", origin: "Dallas, TX", status: "available" } },
      ],
    });
    const seen: unknown[] = [];
    const domain = await domainWith(t);
    const world = worldFor(domain, t);
    const runner = createToolRunner(domain, world, (e) => seen.push(e.eventChanges), t);
    const found = runner.call("search_loads", { origin: "Dallas", destination: "Atlanta" });
    // The search saw the load before someone else booked it.
    expect((found.result as { load_id: string }[]).map((l) => l.load_id)).toEqual(["L-1001"]);
    expect(seen[0]).toEqual([{ table: "loads", key: "L-1001", kind: "update", before: expect.objectContaining({ status: "available" }), after: expect.objectContaining({ status: "booked" }) }]);
    expect(runner.call("book_load", BOOK).error).toBe("Load L-1001 is not available");
    runner.call("get_load", { load_id: "L-9999" });
    expect(world.get("loads", "L-1099")).toBeUndefined();
    runner.call("get_load", { load_id: "L-1001" });
    expect(world.get("loads", "L-1099")).toMatchObject({ status: "available" });
    expect(seen.at(-1)).toEqual([{ table: "loads", key: "L-1099", kind: "insert", after: { load_id: "L-1099", origin: "Dallas, TX", status: "available" } }]);
    expect(runner.eventsFired).toEqual(new Set([0, 1]));
  });
});

describe("faults: runs, lint and regrade", () => {
  const t = task({
    faults: [{ tool: "book_load", call: 1, error: "timeout", after_commit: true, latency_ms: 30 }],
    events: [{ after: { tool: "verify_carrier", call: 1 }, update: "loads", key: "L-1002", set: { status: "covered" } }],
  });
  const agent = callingAgent([["verify_carrier", { mc_number: "100101" }], ["book_load", BOOK], ["book_load", BOOK]]);

  it("records the fault and the events in the trajectory, waits out the latency, and grades the trial", async () => {
    const domain = await domainWith(t);
    const r = await runEpisode({ domain, task: domain.tasks[0]!, agent, user: scriptedUser(), trial: 0 });
    expect(r.skipped).toBeUndefined();
    expect(r.error).toBeUndefined();
    const tools = r.events.filter((e) => e.type === "tool");
    expect(tools[0]).toMatchObject({ name: "verify_carrier", eventChanges: [{ table: "loads", key: "L-1002", kind: "update" }] });
    expect(tools[1]).toMatchObject({ name: "book_load", ok: false, error: "book_load timed out: no response from the server", fault: { error: "timeout", status: 504, latencyMs: 30, committed: true } });
    expect(tools[1]).not.toHaveProperty("eventChanges");
    // The retry breaks book-available-load: the booking the agent didn't see had gone through.
    expect(tools[2]).toMatchObject({ name: "book_load", ok: false, error: "Load L-1001 is not available", violations: ["book-available-load"] });
    expect(tools[2]).not.toHaveProperty("fault");
    expect(r.passed).toBe(false);
    expect(r.changes.map((c) => `${c.kind} ${c.table} ${c.key}`)).toEqual(expect.arrayContaining(["insert bookings bookings-1", "update loads L-1001", "update loads L-1002"]));
    const turn = r.events.find((e) => e.type === "agent")!;
    expect(turn.type === "agent" && turn.latencyMs).toBeGreaterThanOrEqual(25);
  });

  it("regrade replays the faults and events, and refuses a trial whose fault changed", async () => {
    const domain = await domainWith(t);
    const run = await runSuite({ domain, agent, user: scriptedUser() });
    const again = regradeSuite(domain, run);
    expect(again.tasks[0]!.trials[0]!.events).toEqual(run.tasks[0]!.trials[0]!.events);
    const edited = { ...domain, tasks: [{ ...t, faults: [{ tool: "book_load", call: 1, error: "server_error" as const }] }] };
    expect(() => regradeSuite(edited, run)).toThrow(RegradeError);
    expect(() => regradeSuite(edited, run)).toThrow(/tool call 2 \(book_load\) now returns something other than what the agent saw/);
  });

  it("lint replays a reference through the faults, and warns about a fault or an event the reference never reaches", async () => {
    const reference = [
      { tool: "verify_carrier", args: { mc_number: "100101" } },
      { tool: "book_load", args: BOOK, expect_error: "timed out" },
      { tool: "get_load", args: { load_id: "L-1001" } },
    ];
    const good = task({ id: "good", reference, faults: [{ tool: "book_load", call: 1, error: "timeout", after_commit: true }] });
    const missed = task({
      id: "missed",
      reference,
      faults: [
        { tool: "book_load", call: 1, error: "timeout", after_commit: true },
        { tool: "book_load", call: 2, error: "timeout" },
        { tool: "log_offer", error: "rate_limit" },
      ],
      events: [{ after: { tool: "get_load", call: 3 }, update: "loads", key: "L-1002", set: { status: "covered" } }],
    });
    const report = lintDomain(await domainWith(good, missed));
    expect(report.tasks[0]).toMatchObject({ solvable: true, errors: [], warnings: [] });
    expect(report.tasks[1]!.solvable).toBe(true);
    expect(report.tasks[1]!.warnings).toEqual([
      "faults[1] (book_load, call 2) never hits the reference's calls: check its call number",
      "faults[2] (log_offer) never hits the reference's calls: check its call number",
      "events[0] (after get_load, call 3) never fires in the reference's calls: check its call number",
    ]);
    // Without expect_error, the faulted reference call is an error.
    const plain = task({ id: "plain", reference: reference.map(({ expect_error: _, ...c }) => c), faults: good.faults });
    expect(lintDomain(await domainWith(plain)).tasks[0]!.errors).toContain("reference[1] book_load failed: book_load timed out: no response from the server");
  });

  it("changes a task's inputs hash for --baseline, not the hash regrade checks, and leaves a task without them as before", async () => {
    const domain = await domainWith(task({ id: "a" }), task({ id: "b", faults: [{ tool: "book_load", error: "timeout" }] }));
    const [a, b] = domain.tasks as [Task, Task];
    expect(taskFingerprints(domain, a, "scripted").inputs).not.toBe(taskFingerprints(domain, { ...a, faults: b.faults }, "scripted").inputs);
    expect(taskFingerprints(domain, { ...a, events: [{ after: { tool: "get_load", call: 1 }, update: "loads", key: "L-1001", set: {} }] }, "scripted").inputs).not.toBe(taskFingerprints(domain, a, "scripted").inputs);
    expect(taskFingerprints(domain, { ...b, faults: undefined, id: "a" }, "scripted")).toEqual(taskFingerprints(domain, a, "scripted"));
    expect(inputsFingerprint(domain, ["b"], "scripted")).toBe(inputsFingerprint({ ...domain, tasks: [{ ...b, faults: undefined }] }, ["b"], "scripted"));
  });

  it("shows the fault and the events' changes on the call in the HTML report", async () => {
    const domain = await domainWith(t);
    const html = renderHtml(await runSuite({ domain, agent, user: scriptedUser() }));
    expect(html).toContain("function fault(f)");
    expect(html).toContain('"fault":{"error":"timeout","status":504,"latencyMs":30,"committed":true}');
    expect(html).toContain("then, by the task's events: ");
  });
});

describe("lint and events", () => {
  it("counts a row an event creates as reachable for the task's expectations", async () => {
    const d = await loadDomain(example);
    const fresh = { ...d, world: { tables: { ...d.world.tables, notices: { key: "notice_id", rows: [] } } } };
    const t = task({
      id: "notice",
      events: [{ after: { tool: "get_load", call: 1 }, create: "notices", values: { notice_id: "N-1", text: "L-1001 is covered" } }],
      reference: [{ tool: "get_load", args: { load_id: "L-1001" } }],
      expect: { state: [{ table: "notices", key: "N-1" }], called: [], not_called: [], reply_includes: [] },
    });
    const report = lintDomain({ ...fresh, tasks: [t] });
    expect(report.tasks[0]).toMatchObject({ ready: true, solvable: true, errors: [] });
  });
});

describe("faults in the freight example", () => {
  it("the careful agent looks the load up after a timeout and searches again after a rate limit; the naive one books twice and gives up", async () => {
    const domain = await loadDomain(example);
    const tasks = ["booking-times-out-after-it-lands", "search-rate-limited"];
    const careful = await runSuite({ domain, agent: freightScriptedAgent("careful"), user: scriptedUser(), taskIds: tasks });
    expect(careful.tasks.map((x) => [x.id, x.passes])).toEqual([[tasks[0], 1], [tasks[1], 1]]);
    const naive = await runSuite({ domain, agent: freightScriptedAgent("naive"), user: scriptedUser(), taskIds: tasks });
    const [timeout, limited] = naive.tasks.map((x) => x.trials[0]!);
    expect(timeout!.violations.map((v) => v.invariant)).toContain("book-available-load");
    expect(limited!.checks.filter((c) => !c.passed).map((c) => c.id)).toEqual(["state:bookings#1"]);
  });
});
