import path from "node:path";
import { describe, expect, it } from "vitest";
import { freightScriptedAgent } from "../src/demo/freight-agents.ts";
import { runSuite } from "../src/run/suite.ts";
import { noopAgent } from "../src/sim/noop.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import type { AgentAdapter } from "../src/sim/types.ts";
import { DomainError, loadDomain, pendingReview, validateDomain } from "../src/spec/load.ts";
import { DomainSpec } from "../src/spec/schema.ts";

const example = path.resolve("examples/freight");

describe("freight example, offline", () => {
  it("the careful agent passes every task", async () => {
    const r = await runSuite({ domain: await loadDomain(example), agent: freightScriptedAgent("careful"), user: scriptedUser() });
    expect(r.tasks.filter((t) => t.passes === 0).map((t) => t.id)).toEqual([]);
    expect(r.passHat["1"]).toBe(1);
  });

  it("the naive agent is caught by the invariants", async () => {
    const r = await runSuite({ domain: await loadDomain(example), agent: freightScriptedAgent("naive"), user: scriptedUser() });
    expect(r.passHat["1"]).toBeCloseTo(5 / 50);
    const modes = Object.fromEntries(r.failureModes.map((m) => [m.id, m.count]));
    expect(modes).toMatchObject({
      "verify-before-book": 43,
      "eligible-carrier": 9,
      "rate-ceiling": 13,
      "equipment-match": 3,
      "rep-confirm-not-booked": 6,
      "verify-before-submit": 6,
      "submit-ceiling": 3,
      "eligible-carrier-submit": 1,
      "eligible-carrier-capacity": 2,
      "eligible-carrier-callback": 1,
    });
  });

  it("fails a trial whose agent leaks the rate ceiling", async () => {
    const leaky: AgentAdapter = {
      name: "leaky",
      async createSession() {
        return {
          async reply(_text, callTool) {
            await callTool("get_load", { load_id: "L-1001" });
            return "Honestly, the most we can pay on L-1001 is $2,350.";
          },
        };
      },
    };
    const r = await runSuite({ domain: await loadDomain(example), agent: leaky, user: scriptedUser(), taskIds: ["no-mc-number"] });
    const trial = r.tasks[0]!.trials[0]!;
    expect(trial.passed).toBe(false);
    expect(trial.violations[0]).toMatchObject({ invariant: "never-disclose-ceiling", messageIndex: 0 });
  });

  it("the noop baseline passes exactly the tasks that reward doing nothing", async () => {
    const r = await runSuite({ domain: await loadDomain(example), agent: noopAgent(), user: scriptedUser() });
    const passed = r.tasks.filter((t) => t.passes > 0).map((t) => t.id);
    expect(passed).toEqual([
      "walk-away-above-ceiling",
      "expired-insurance",
      "inactive-authority",
      "do-not-use-carrier",
      "no-mc-number",
      "ceiling-probe-no-deal",
      "rep-confirm-above-ceiling",
      "rep-confirm-ineligible-carrier",
      "do-not-use-capacity",
      "ineligible-callback-request",
      "no-booking-without-yes",
      "out-of-window-no-alternative",
      "unsatisfactory-safety",
      "unknown-mc-number",
      "broker-authority",
      "wrong-equipment-insists",
    ]);
    expect(r.passHat["1"]).toBeCloseTo(16 / 50);
    const byTag = Object.fromEntries(r.byTag.map((t) => [t.tag, t.passHat1]));
    // Every hard-tier refusal requires a lookup or a handoff, so doing nothing passes none of them.
    expect(byTag).toMatchObject({ refusal: 14 / 17, vetting: 10 / 18, "happy-path": 0, negotiation: 3 / 14, handoff: 0, capacity: 1 / 6, "rep-confirm": 2 / 6, hard: 0 });
    expect(r.byTag[0]!.passHat1).toBe(0);
  });

  it("runs k trials per task and reports pass^1..k", async () => {
    const r = await runSuite({
      domain: await loadDomain(example),
      agent: freightScriptedAgent("careful"),
      user: scriptedUser(),
      k: 3,
      taskIds: ["book-at-posted-rate"],
    });
    expect(r.tasks[0]!.trials).toHaveLength(3);
    expect(Object.keys(r.passHat)).toEqual(["1", "2", "3"]);
  });

  it("records agent errors as failed trials instead of crashing the run", async () => {
    const broken: AgentAdapter = {
      name: "broken",
      async createSession() {
        return {
          async reply() {
            throw new Error("boom");
          },
        };
      },
    };
    const r = await runSuite({ domain: await loadDomain(example), agent: broken, user: scriptedUser(), taskIds: ["no-mc-number"] });
    const trial = r.tasks[0]!.trials[0]!;
    expect(trial.passed).toBe(false);
    expect(trial.endReason).toBe("error");
    expect(trial.checks[0]).toMatchObject({ id: "runtime", detail: "boom" });
  });

  it("returns unknown tools and bad arguments to the agent as tool errors", async () => {
    const outcomes: unknown[] = [];
    const agent: AgentAdapter = {
      name: "probe",
      async createSession() {
        return {
          async reply(_msg, callTool) {
            outcomes.push(await callTool("delete_everything", {}));
            outcomes.push(await callTool("get_load", { id: "L-1001" }));
            return "ok";
          },
        };
      },
    };
    await runSuite({ domain: await loadDomain(example), agent, user: scriptedUser(), taskIds: ["no-mc-number"] });
    expect(outcomes.slice(0, 2)).toEqual([
      { ok: false, error: 'unknown tool "delete_everything"', result: undefined },
      { ok: false, error: 'unknown argument "id"', result: undefined },
    ]);
  });
});

describe("review workflow", () => {
  it("lists pending drafted items and marks runs provisional", async () => {
    const d = await loadDomain(example);
    const drafted = DomainSpec.parse({
      ...d,
      invariants: [
        ...d.invariants,
        { id: "readback", description: "Read back before booking", review: "pending", source: { file: "policy.md", quote: "read back the load ID" }, never: { tool: "book_load", when: { rate: { $lt: 0 } } } },
      ],
      tasks: d.tasks.map((t, i) => (i === 0 ? { ...t, review: "pending" } : { ...t, review: "accepted" })),
    });
    expect(pendingReview(drafted)).toEqual([
      { kind: "invariant", id: "readback", source: { file: "policy.md", quote: "read back the load ID" } },
      { kind: "task", id: "book-at-posted-rate", source: undefined },
    ]);
    const r = await runSuite({ domain: drafted, agent: freightScriptedAgent("careful"), user: scriptedUser(), taskIds: ["no-mc-number"] });
    expect(r.pendingReview).toHaveLength(2);
  });

  it("treats a hand-written domain as fully reviewed", async () => {
    expect(pendingReview(await loadDomain(example))).toEqual([]);
  });
});

describe("domain validation", () => {
  it("reports cross-reference errors", async () => {
    const d = await loadDomain(example);
    const broken = {
      ...d,
      invariants: [{ id: "x", description: "x", before: { first: "verify_carrier", then: "book_it", same: ["mc"] } }],
      tasks: [{ ...d.tasks[0]!, persona: "nobody", expect: { ...d.tasks[0]!.expect, called: ["fly"] } }],
    };
    expect(validateDomain(broken)).toEqual([
      'invariants.x: unknown tool "book_it"',
      'invariants.x: tool "verify_carrier" has no param "mc"',
      'tasks.book-at-posted-rate: unknown persona "nobody"',
      'tasks.book-at-posted-rate.expect: unknown tool "fly"',
    ]);
  });

  it("checks every tool and argument in a never_disclose exception list", async () => {
    const d = await loadDomain(example);
    const unless = [{ tool: "book_load", arg: "rate" }, { tool: "submit_offer", arg: "price" }, { tool: "hold_load", arg: "rate" }];
    const broken = { ...d, invariants: [{ id: "x", description: "x", never_disclose: { table: "loads", field: "max_rate", unless } }] };
    expect(validateDomain(broken)).toEqual(['invariants.x: tool "submit_offer" has no param "price"', 'invariants.x: unknown tool "hold_load"']);
  });

  it("checks the references resolve() reads in a tool, and only those", async () => {
    const d = await loadDomain(example);
    const getLoad = d.tools.find((t) => t.name === "get_load")!;
    const withGetLoad = (changes: object) => ({ ...d, tools: [...d.tools.filter((t) => t !== getLoad), { ...getLoad, ...changes }] });
    // Literal text at run time, so there is nothing to resolve.
    const where = { load_id: "$load_id", price_range: "$$", tier: "$$$", unit: "$/hr", per: "$USD/kg", currency: "$€", rate: "$5", kind: "$@id", note: "${} or $ {x}" };
    expect(validateDomain(withGetLoad({ ops: [{ list: "loads", where }] }))).toEqual([]);
    const broken = withGetLoad({
      checks: [{ table: "loads", key: "$constructor", error: "load ${load} not found, ${load_id} is fine, ${toString} is not" }],
      ops: [{ get: "loads", key: "$loadId" }],
    });
    expect(validateDomain(broken)).toEqual([
      'tools.get_load.checks[0]: "$constructor" never resolves: tool "get_load" has no param "constructor"',
      'tools.get_load.checks[0]: "${load}" never resolves: tool "get_load" has no param "load"',
      'tools.get_load.checks[0]: "${toString}" never resolves: tool "get_load" has no param "toString"',
      'tools.get_load.ops[0]: "$loadId" never resolves: tool "get_load" has no param "loadId"',
    ]);
  });

  it("rejects a missing file with a clear error", async () => {
    await expect(loadDomain(path.resolve("examples/does-not-exist"))).rejects.toThrow(/no sandtable.yaml found at .*does-not-exist/);
    expect(DomainError).toBeDefined();
  });
});
