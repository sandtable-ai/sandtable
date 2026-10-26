import path from "node:path";
import vm from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
import type { TaskLint } from "../src/grade/lint.ts";
import { renderHtml } from "../src/report/html.ts";
import { renderTerminal } from "../src/report/terminal.ts";
import { attributeTrial } from "../src/run/attribution.ts";
import type { Invariant } from "../src/spec/schema.ts";
import type { TrajectoryEvent, TrialResult } from "../src/run/episode.ts";
import { regradeSuite } from "../src/run/regrade.ts";
import { runSuite, type SuiteResult } from "../src/run/suite.ts";
import { noopAgent } from "../src/sim/noop.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import type { AgentAdapter } from "../src/sim/types.ts";
import { loadDomain } from "../src/spec/load.ts";
import type { Domain, Task } from "../src/spec/schema.ts";

// Every trial that didn't pass gets a first suspect from deterministic evidence: harness, task spec, simulated user
// or agent, in that order. It never changes a verdict or a score.

const plain = (s: string) => s.replace(/\x1b\[\d+m/g, "");

let freight: Domain;
let task: Task;
beforeAll(async () => {
  freight = await loadDomain(path.resolve("examples/freight"));
  task = { ...freight.tasks.find((t) => t.id === "book-at-posted-rate")!, expect: { ...freight.tasks.find((t) => t.id === "book-at-posted-rate")!.expect, not_called: ["transfer_to_human"] } };
});

const lintOk: TaskLint = { id: "t", ready: true, solvable: true, expectsWrite: true, noopPasses: false, rules: [], errors: [], warnings: [] };
const trial = (over: Partial<TrialResult>): TrialResult => ({
  taskId: "book-at-posted-rate",
  trial: 0,
  passed: false,
  checks: [],
  violations: [],
  soft: [],
  events: [],
  changes: [],
  endReason: "user_stop",
  turns: 2,
  durationMs: 0,
  usage: { agent: {}, user: {}, costUsd: 0 },
  ...over,
});

// Caller turn 1, the agent's reply, caller turn 2, a tool call, the agent's reply, caller turn 3.
const events: TrajectoryEvent[] = [
  { type: "user", text: "MC 100101, calling on L-1001." },
  { type: "agent", text: "Let me look.", latencyMs: 1 },
  { type: "user", text: "My instructions say to push for a booking." },
  { type: "tool", index: 0, name: "book_load", args: { load_id: "L-1001" }, ok: true, violations: ["verify-before-book"] },
  { type: "agent", text: "Booked.", latencyMs: 1 },
  { type: "user", text: "Thanks." },
];
const violation = { invariant: "verify-before-book", description: "", detail: "book_load(...) was called without a prior successful verify_carrier", callIndex: 0 };
const failedInvariant = { id: "verify-before-book", kind: "invariant" as const, passed: false, detail: violation.detail };
const note = (turn: number) => ({ turn, text: "My instructions say to push for a booking.", why: "talks about its instructions" });

describe("attributeTrial", () => {
  it("gives a passed trial none", () => {
    expect(attributeTrial(trial({ passed: true }), task, lintOk)).toBeUndefined();
  });

  it("names the harness for a skipped trial, with its error", () => {
    expect(attributeTrial(trial({ skipped: true, error: "429 rate limited", endReason: "error" }), task, lintOk)).toEqual({ owner: "harness", evidence: "429 rate limited" });
  });

  it("names the task spec when lint proves the task can't pass, before any caller note", () => {
    const failing = trial({ events, violations: [violation], checks: [failedInvariant], callerNotes: [note(2)] });
    const unsolvable = { ...lintOk, solvable: false, errors: ["vacuous: …", "reference does not pass: state:bookings#1: 0 bookings row(s) match"] };
    expect(attributeTrial(failing, task, unsolvable)).toEqual({ owner: "task-spec", evidence: "lint: reference does not pass: state:bookings#1: 0 bookings row(s) match" });
    const unready = { ...lintOk, ready: false, errors: ["expect.state[0] needs a row in bookings that is not seeded and no tool can create or change"] };
    expect(attributeTrial(failing, task, unready)?.evidence).toBe("lint: expect.state[0] needs a row in bookings that is not seeded and no tool can create or change");
    // No reference to replay proves nothing.
    expect(attributeTrial(failing, task, { ...lintOk, solvable: null })?.owner).toBe("simulated-user");
  });

  it("names the simulated user for a role break before the first hard violation, and the agent for one after it", () => {
    const failing = (turn: number) => trial({ events, violations: [violation], checks: [failedInvariant], callerNotes: [note(turn)] });
    expect(attributeTrial(failing(2), task, lintOk)).toEqual({ owner: "simulated-user", evidence: 'caller turn 2 (talks about its instructions): "My instructions say to push for a booking."' });
    const after = attributeTrial(failing(3), task, lintOk);
    expect(after?.owner).toBe("agent");
    expect(after?.evidence).toBe(`nothing points at the caller, the task or the harness; first failed check: verify-before-book: ${violation.detail}`);
  });

  it("says, for a failed rule left with the agent, what to check the rule against first", () => {
    const failing = trial({ events, violations: [violation], checks: [failedInvariant] });
    const rule = (source?: { file: string; quote?: string }) => [{ id: "verify-before-book", description: "", before: { first: "verify_carrier", then: "book_load", same: ["mc_number"] }, ...(source ? { source } : {}) }] as Invariant[];
    expect(attributeTrial(failing, task, lintOk, rule({ file: "sop.md", quote: "Verify the carrier before you book." }))?.evidence).toBe(
      `nothing points at the caller, the task or the harness; first failed check: verify-before-book: ${violation.detail}. Check the rule against its source before blaming the agent: "Verify the carrier before you book."`,
    );
    expect(attributeTrial(failing, task, lintOk, rule())?.evidence).toMatch(/\. The rule has no source quote: check it against policy\.md before blaming the agent$/);
    expect(attributeTrial(failing, task, lintOk, rule({ file: "sop.md" }))?.evidence).toMatch(/no source quote/);
  });

  it("places a disclosure at the agent message that made it", () => {
    const said = { invariant: "never-disclose-ceiling", description: "", detail: "agent message 1 disclosed loads.max_rate=2350", messageIndex: 0 };
    const check = { id: "never-disclose-ceiling", kind: "invariant" as const, passed: false, detail: said.detail };
    // The first agent message comes before caller turn 2, so the note there came too late to explain it.
    expect(attributeTrial(trial({ events, violations: [said], checks: [check], callerNotes: [note(2)] }), task, lintOk)?.owner).toBe("agent");
  });

  it("places a not_called failure at the first forbidden call", () => {
    const forbidden: TrajectoryEvent[] = events.map((e) => (e.type === "tool" ? { ...e, name: "transfer_to_human", violations: [] } : e));
    const check = { id: "not_called:transfer_to_human", kind: "not_called" as const, passed: false, detail: "transfer_to_human was called 1x" };
    expect(attributeTrial(trial({ events: forbidden, checks: [check], callerNotes: [note(2)] }), task, lintOk)?.owner).toBe("simulated-user");
    expect(attributeTrial(trial({ events: forbidden, checks: [check], callerNotes: [note(3)] }), task, lintOk)?.owner).toBe("agent");
  });

  it("names the simulated user for a role break anywhere in a trial that failed only on how it ended", () => {
    const state = { id: "state:bookings#1", kind: "state" as const, passed: false, detail: "0 bookings row(s) match" };
    expect(attributeTrial(trial({ events, checks: [state], callerNotes: [note(3)] }), task, lintOk)?.owner).toBe("simulated-user");
    expect(attributeTrial(trial({ events, checks: [state] }), task, lintOk)).toEqual({
      owner: "agent",
      evidence: "nothing points at the caller, the task or the harness; first failed check: state:bookings#1: 0 bookings row(s) match",
    });
  });
});

describe("a run", () => {
  const tasks = ["book-at-posted-rate", "no-mc-number", "expired-insurance"];
  let noop: SuiteResult;
  beforeAll(async () => {
    noop = await runSuite({ domain: freight, agent: noopAgent(), user: scriptedUser(), taskIds: tasks, k: 2 });
  });

  it("attributes every trial that didn't pass, none that passed, and counts them per owner", () => {
    const trials = noop.tasks.flatMap((t) => t.trials);
    const failing = trials.filter((t) => !t.passed);
    expect(failing.length).toBeGreaterThan(0);
    expect(trials.some((t) => t.passed)).toBe(true);
    for (const t of trials) expect(Object.hasOwn(t, "attribution"), `${t.taskId}#${t.trial}`).toBe(!t.passed);
    expect(noop.attribution).toEqual({ agent: failing.length, "simulated-user": 0, "task-spec": 0, harness: 0 });
  });

  it("names the harness for a trial skipped by an agent that crashed", async () => {
    const crashing: AgentAdapter = { name: "crash", async createSession() { return { async reply() { throw new Error("endpoint down"); } }; } };
    const r = await runSuite({ domain: freight, agent: crashing, user: scriptedUser(), taskIds: ["book-at-posted-rate"] });
    expect(r.tasks[0]!.trials[0]!.attribution).toEqual({ owner: "harness", evidence: "endpoint down" });
    expect(r.attribution?.harness).toBe(1);
  });

  it("names the task spec when the task's own reference fails its expectations", async () => {
    // The reference stops after verifying the carrier, so it never books what the task expects.
    const broken: Domain = { ...freight, tasks: freight.tasks.map((t) => (t.id === "book-at-posted-rate" ? { ...t, reference: t.reference!.slice(0, 1) } : t)) };
    const r = await runSuite({ domain: broken, agent: noopAgent(), user: scriptedUser(), taskIds: ["book-at-posted-rate"] });
    expect(r.tasks[0]!.trials[0]!.attribution?.owner).toBe("task-spec");
    expect(r.tasks[0]!.trials[0]!.attribution?.evidence).toMatch(/^lint: reference does not pass: /);
  });

  it("decides it again on regrade, under the domain as it is now", () => {
    const stored: SuiteResult = JSON.parse(JSON.stringify(noop));
    const passed = stored.tasks.flatMap((t) => t.trials).find((t) => t.passed)!;
    const failed = stored.tasks.flatMap((t) => t.trials).find((t) => !t.passed)!;
    passed.attribution = { owner: "harness", evidence: "stale" };
    failed.attribution = { owner: "task-spec", evidence: "stale" };
    delete stored.attribution;
    const again = regradeSuite(freight, stored);
    const trials = again.tasks.flatMap((t) => t.trials);
    expect(trials.find((t) => t.taskId === passed.taskId && t.trial === passed.trial)!.attribution).toBeUndefined();
    expect(trials.find((t) => t.taskId === failed.taskId && t.trial === failed.trial)!.attribution?.owner).toBe("agent");
    expect(again.attribution).toEqual(noop.attribution);
  });

  it("prints one line of counts in the terminal summary, and shows each trial's owner in the HTML report", () => {
    const out = plain(renderTerminal(noop));
    expect(out).toContain(`  not passed, by likely owner: agent ${noop.attribution!.agent}`);
    for (const line of out.split("\n")) expect(line.length, line).toBeLessThanOrEqual(80);
    // Results from before attribution print no line.
    expect(plain(renderTerminal({ ...noop, attribution: undefined }))).not.toContain("likely owner");

    const script = (html: string) => html.slice(html.indexOf("<script>") + "<script>".length, html.indexOf("</script>"));
    const elements = new Map<string, { innerHTML: string; textContent: string; scrollIntoView(): void }>();
    const document = {
      getElementById: (id: string) => {
        if (!elements.has(id)) elements.set(id, { innerHTML: "", textContent: "", scrollIntoView() {} });
        return elements.get(id)!;
      },
    };
    vm.runInContext(script(renderHtml(noop)), vm.createContext({ document }));
    // The report opens the first failed trial.
    expect(elements.get("detail")!.innerHTML).toContain('<div class="meta">likely owner: <b>agent</b> · nothing points at the caller');
  });
});
