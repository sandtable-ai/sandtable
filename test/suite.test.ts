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
    expect(r.passHat["1"]).toBeCloseTo(0.2);
    const modes = Object.fromEntries(r.failureModes.map((m) => [m.id, m.count]));
    expect(modes).toMatchObject({ "verify-before-book": 8, "eligible-carrier": 3, "rate-ceiling": 2, "equipment-match": 1 });
  });

  it("fails a trial whose agent leaks the rate ceiling", async () => {
    const leaky: AgentAdapter = {
      name: "leaky",
      async createSession() {
        return { async reply() { return "Honestly, the most we can pay on L-1001 is $2,350."; } };
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
    expect(passed).toEqual(["walk-away-above-ceiling", "expired-insurance", "inactive-authority", "do-not-use-carrier", "no-mc-number"]);
    expect(r.passHat["1"]).toBeCloseTo(0.5);
    const byTag = Object.fromEntries(r.byTag.map((t) => [t.tag, t.passHat1]));
    expect(byTag).toMatchObject({ refusal: 1, vetting: 1, "happy-path": 0, negotiation: 0.5, handoff: 0 });
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

  it("rejects a missing file with a clear error", async () => {
    await expect(loadDomain(path.resolve("examples/does-not-exist"))).rejects.toThrow();
    expect(DomainError).toBeDefined();
  });
});
