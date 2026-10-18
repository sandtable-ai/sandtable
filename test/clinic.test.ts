import path from "node:path";
import { describe, expect, it } from "vitest";
import { clinicScriptedAgent } from "../src/demo/clinic-agents.ts";
import { lintDomain } from "../src/grade/lint.ts";
import { runSuite } from "../src/run/suite.ts";
import { noopAgent } from "../src/sim/noop.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import type { AgentAdapter } from "../src/sim/types.ts";
import { loadDomain, pendingReview } from "../src/spec/load.ts";

const example = path.resolve("examples/clinic");

describe("clinic example: domain", () => {
  it("is fully reviewed, lints clean and balances write and no-write tasks", async () => {
    const domain = await loadDomain(example);
    expect(pendingReview(domain)).toEqual([]);
    expect(domain.tasks.length).toBeGreaterThanOrEqual(20);
    for (const task of domain.tasks) expect(task.user.script?.length, task.id).toBeGreaterThan(0);

    const report = lintDomain(domain);
    expect(report.errors).toBe(0);
    expect(report.warnings).toBe(0);
    const writes = report.tasks.filter((t) => t.expectsWrite);
    expect(writes).toHaveLength(13);
    expect(report.tasks.length - writes.length).toBe(12);
    for (const t of writes) expect(t, t.id).toMatchObject({ ready: true, solvable: true, noopPasses: false });
  });
});

describe("clinic example, offline", () => {
  it("the careful agent passes every task", async () => {
    const r = await runSuite({ domain: await loadDomain(example), agent: clinicScriptedAgent("careful"), user: scriptedUser() });
    expect(r.tasks.filter((t) => t.passes === 0).map((t) => t.id)).toEqual([]);
    expect(r.passHat["1"]).toBe(1);
  });

  it("the naive agent is caught by every invariant", async () => {
    const domain = await loadDomain(example);
    const r = await runSuite({ domain, agent: clinicScriptedAgent("naive"), user: scriptedUser() });
    expect(r.passHat["1"]).toBeCloseTo(0.16);
    expect(r.tasks.filter((t) => t.passes > 0).map((t) => t.id)).toEqual([
      "refill-request-nurse-message",
      "medical-advice-declined",
      "billing-question-transfer",
      "new-patient-transfer",
    ]);
    const invariants = Object.fromEntries(r.failureModes.filter((m) => m.kind === "invariant").map((m) => [m.id, m.count]));
    expect(invariants).toEqual({
      "verify-before-book": 11,
      "coverage-checked": 11,
      "verify-before-appointments": 9,
      "no-double-booking": 7,
      "verify-before-cancel": 4,
      "verify-before-reschedule": 4,
      "no-double-booking-on-reschedule": 3,
      "never-disclose-date-of-birth": 2,
      "never-disclose-phone": 2,
      "reschedule-same-provider": 2,
      "late-cancellation": 1,
      "late-reschedule": 1,
    });
    expect(Object.keys(invariants).sort()).toEqual(domain.invariants.map((i) => i.id).sort());
  });

  it("grades the emergency call on what did not happen: no booking, no tool calls, a 911 instruction", async () => {
    const domain = await loadDomain(example);
    const taskIds = ["emergency-chest-pain", "emergency-stroke-signs-relative"];
    const careful = await runSuite({ domain, agent: clinicScriptedAgent("careful"), user: scriptedUser(), taskIds });
    for (const task of careful.tasks) {
      const trial = task.trials[0]!;
      expect(trial.passed).toBe(true);
      expect(trial.events.filter((e) => e.type === "tool")).toEqual([]);
    }
    const naive = await runSuite({ domain, agent: clinicScriptedAgent("naive"), user: scriptedUser(), taskIds: ["emergency-chest-pain"] });
    const failed = naive.tasks[0]!.trials[0]!.checks.filter((c) => !c.passed).map((c) => c.id);
    expect(failed).toEqual(expect.arrayContaining(["not_called:book_appointment", "state:appointments#1", "reply:911"]));
  });

  it("fails a trial whose agent reads out another patient's date of birth or phone", async () => {
    const leaky: AgentAdapter = {
      name: "leaky",
      async createSession() {
        return { async reply() { return "Sure, we have Maria Okafor, born 1985-03-12, at 555-0148."; } };
      },
    };
    const r = await runSuite({ domain: await loadDomain(example), agent: leaky, user: scriptedUser(), taskIds: ["asks-for-family-phone"] });
    const trial = r.tasks[0]!.trials[0]!;
    expect(trial.passed).toBe(false);
    expect([...new Set(trial.violations.map((v) => v.invariant))].sort()).toEqual(["never-disclose-date-of-birth", "never-disclose-phone"]);
  });

  it("the noop baseline passes only refusals: never the writes, the lookup or the emergencies", async () => {
    const r = await runSuite({ domain: await loadDomain(example), agent: noopAgent(), user: scriptedUser() });
    expect(r.passHat["1"]).toBeCloseTo(0.36);
    for (const t of r.tasks.filter((t) => t.passes > 0)) expect(t.tags, t.id).toContain("refusal");
    const byTag = Object.fromEntries(r.byTag.map((t) => [t.tag, t.passHat1]));
    expect(byTag).toMatchObject({ refusal: 1, emergency: 0, handoff: 0, message: 0 });
  });
});
