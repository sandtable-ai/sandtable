import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { freightScriptedAgent } from "../src/demo/freight-agents.ts";
import { isSkipped, type CheckResult } from "../src/grade/expectations.ts";
import { passAtK, passHatK, wilsonInterval } from "../src/grade/passk.ts";
import { renderHtml } from "../src/report/html.ts";
import { renderTerminal } from "../src/report/terminal.ts";
import { changedVerdicts, regradeSuite } from "../src/run/regrade.ts";
import { runSuite, skippedTrials, trialStatus, type SuiteResult } from "../src/run/suite.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import type { AgentAdapter } from "../src/sim/types.ts";
import { loadDomain } from "../src/spec/load.ts";

// A trial that ends in an error before the agent broke a rule is skipped: not graded, left out of
// pass^k and pass@k, and listed on its own. Tasks get a verdict over their graded trials.

const example = path.resolve("examples/freight");
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const check = (kind: CheckResult["kind"], passed: boolean): CheckResult => ({ id: kind, kind, passed, detail: "" });

const careful = freightScriptedAgent("careful");
const naive = freightScriptedAgent("naive");

/**
 * Careful on trial 0 and 2, naive on trial 1 (so tasks the naive agent fails are flaky), and a rate limit on
 * trial 2 of `no-mc-number` and `expired-insurance`.
 */
const mixed: AgentAdapter = {
  name: "mixed",
  async createSession(input) {
    const [, task, trial] = /\/([^/#]+)#(\d+)$/.exec(input.sessionId)!;
    if (trial === "2" && (task === "no-mc-number" || task === "expired-insurance")) throw new Error("429 Too Many Requests");
    return (trial === "1" ? naive : careful).createSession(input);
  },
};
const tasks = ["book-at-posted-rate", "expired-insurance", "no-mc-number"];

/** Books L-1001 without verifying the carrier, breaking verify-before-book, then crashes. */
const breaksThenCrashes: AgentAdapter = {
  name: "breaks-then-crashes",
  async createSession() {
    return {
      async reply(_text, callTool) {
        await callTool("book_load", { load_id: "L-1001", mc_number: "100101", rate: 2100 });
        throw new Error("connection reset");
      },
    };
  },
};

describe("which errored trials are skipped", () => {
  it("skips a trial that ended in an error with nothing broken, and fails one that broke a rule or a forbidden tool first", () => {
    const runtime = check("runtime", false);
    expect(isSkipped([runtime, check("state", false), check("called", false), check("reply", false)], "429")).toBe(true);
    expect(isSkipped([runtime, check("invariant", false)], "429")).toBe(false);
    expect(isSkipped([runtime, check("not_called", false)], "429")).toBe(false);
    expect(isSkipped([runtime, check("not_called", true)], "429")).toBe(true);
    expect(isSkipped([check("state", false)], undefined)).toBe(false);
  });

  it("fails, and doesn't skip, a live trial whose agent broke an invariant before crashing", async () => {
    const r = await runSuite({ domain: await loadDomain(example), agent: breaksThenCrashes, user: scriptedUser(), taskIds: ["no-mc-number"] });
    const trial = r.tasks[0]!.trials[0]!;
    expect(trial).toMatchObject({ endReason: "error", passed: false });
    expect(trial.skipped).toBeUndefined();
    expect(r.tasks[0]).toMatchObject({ verdict: "failed", graded: 1, skipped: 0 });
    expect(r.failureModes.map((m) => m.id)).toContain("verify-before-book");
  });
});

describe("estimators", () => {
  it("pass@k is the chance that at least one of k trials passes", () => {
    // 1 pass of 4: pass@2 = 1 - C(3,2)/C(4,2) = 1 - 3/6; 0 of 4: 0; 4 of 4: 1.
    expect(passAtK([[true, false, false, false]], 2)).toBeCloseTo(0.5);
    expect(passAtK([[false, false, false, false]], 2)).toBe(0);
    expect(passAtK([[true, true, true, true]], 4)).toBe(1);
    expect(passAtK([[true, false, false, false], [false, false, false, false]], 1)).toBeCloseTo(0.125);
    // Tasks with fewer than k trials are left out, as in pass^k.
    expect(passAtK([[true], [false, false]], 2)).toBe(0);
    expect(passAtK([[true]], 2)).toBeNaN();
  });

  it("the Wilson interval matches hand-computed values and stays inside [0, 1]", () => {
    const four = wilsonInterval(4, 4)!;
    expect(four.low).toBeCloseTo(0.5101, 4);
    expect(four.high).toBe(1);
    const half = wilsonInterval(2, 4)!;
    expect(half.low).toBeCloseTo(0.15, 2);
    expect(half.high).toBeCloseTo(0.85, 2);
    expect(wilsonInterval(0, 3)!.low).toBe(0);
    expect(wilsonInterval(0, 0)).toBeUndefined();
  });
});

describe("a run with passed, failed, flaky and skipped trials", () => {
  async function run(): Promise<SuiteResult> {
    return runSuite({ domain: await loadDomain(example), agent: mixed, user: scriptedUser(), k: 3, taskIds: tasks });
  }

  it("leaves skipped trials out of pass^k and pass@k, and gives each task a verdict", async () => {
    const r = await run();
    const byId = Object.fromEntries(r.tasks.map((t) => [t.id, t]));
    // book-at-posted-rate: ✓✗✓; expired-insurance: ✓✗○; no-mc-number: ✓✓○ (the naive agent refuses without an MC too).
    expect(byId["book-at-posted-rate"]).toMatchObject({ passes: 2, graded: 3, skipped: 0, verdict: "flaky" });
    expect(byId["expired-insurance"]).toMatchObject({ passes: 1, graded: 2, skipped: 1, verdict: "flaky" });
    expect(byId["no-mc-number"]).toMatchObject({ passes: 2, graded: 2, skipped: 1, verdict: "passed" });
    expect(byId["no-mc-number"]!.trials.map(trialStatus)).toEqual(["passed", "passed", "skipped"]);
    expect(byId["no-mc-number"]!.trials[2]).toMatchObject({ passed: false, skipped: true, endReason: "error" });
    expect(byId["no-mc-number"]!.interval!.low).toBeCloseTo(0.342, 3);

    // pass^1 averages 2/3, 1/2 and 2/2; pass^3 and pass@3 count only the task with 3 graded trials.
    expect(r.passHat["1"]).toBeCloseTo((2 / 3 + 1 / 2 + 1) / 3);
    expect(r.passHat["3"]).toBe(0);
    expect(r.passAt!["3"]).toBe(1);
    expect(r.passAt!["2"]).toBeCloseTo((1 + 1 + 1) / 3);
    expect(r.skipped).toBe(2);
    expect(r.flaky).toEqual(["book-at-posted-rate", "expired-insurance"]);
    expect(r.flipRate).toBeCloseTo(2 / 3);
    expect(skippedTrials(r).map((t) => t.taskId)).toEqual(["expired-insurance", "no-mc-number"]);
  });

  it("doesn't count a skipped trial's error as a failure mode", async () => {
    const r = await run();
    expect(r.failureModes.map((m) => m.id)).not.toContain("runtime");
  });

  it("calls a task skipped when no trial of it was graded, and leaves it out of every score", async () => {
    const down: AgentAdapter = { name: "down", async createSession() { throw new Error("503 Service Unavailable"); } };
    const r = await runSuite({ domain: await loadDomain(example), agent: down, user: scriptedUser(), k: 2, taskIds: ["no-mc-number"] });
    expect(r.tasks[0]).toMatchObject({ passes: 0, graded: 0, skipped: 2, verdict: "skipped" });
    expect(r.tasks[0]!.interval).toBeUndefined();
    expect(r.passHat["1"]).toBeNaN();
    expect(r.flipRate).toBeNull();
  });

  it("is reproduced exactly by regrade, which keeps a skipped trial skipped", async () => {
    const r = JSON.parse(JSON.stringify(await run())) as SuiteResult;
    const regraded = regradeSuite(await loadDomain(example), r);
    // As stored: a score with no eligible task is NaN in memory and null in results.json.
    expect(JSON.parse(JSON.stringify({ ...regraded, sandtable: r.sandtable }))).toEqual(r);
    expect(changedVerdicts(r, regraded)).toEqual([]);
  });

  it("is graded again by regrade: a new rule the crashed trial broke first turns skipped into failed", async () => {
    const domain = await loadDomain(example);
    const r = JSON.parse(JSON.stringify(await runSuite({ domain, agent: breaksThenCrashes, user: scriptedUser(), taskIds: ["no-mc-number"] }))) as SuiteResult;
    // Without its invariants, the same crashed trial broke nothing, so it is skipped.
    const lenient = regradeSuite({ ...domain, invariants: [] }, r);
    expect(lenient.tasks[0]!.trials[0]!.skipped).toBe(true);
    const strict = regradeSuite(domain, lenient);
    expect(strict.tasks[0]!.trials[0]!.skipped).toBeUndefined();
    expect(changedVerdicts(lenient, strict).map(({ before, after }) => [trialStatus(before), trialStatus(after)])).toEqual([["skipped", "failed"]]);
  });

  it("prints skipped marks, verdicts, pass@k, the flip rate, flaky tasks and skipped trials within 80 columns", async () => {
    const out = plain(renderTerminal(await run()));
    expect(out).toMatch(/book-at-posted-rate +✓✗✓ +2\/3 {2}flaky\n/);
    expect(out).toMatch(/expired-insurance +✓✗○ +1\/2 {2}critical {2}flaky, 1 skipped\n/);
    expect(out).toMatch(/no-mc-number +✓✓○ +2\/2 {2}1 skipped\n/);
    expect(out).toContain("pass^1 72.2%   pass^3 0.0%   pass@3 100.0%   flip rate 66.7%");
    expect(out).toContain("2 of 9 trial(s) skipped (ended in an error): left out of the scores");
    expect(out).toContain("pass^3 and pass@3 leave out 2 tasks with fewer than 3 graded trials");
    expect(out).toMatch(/Flaky tasks.*\n {2}book-at-posted-rate {2}2 of 3 passed {2}95% interval 21%–94%\n/);
    expect(out).toMatch(/Skipped trials.*\n {2}2× 429 Too Many Requests\n {5}\(expired-insurance, no-mc-number\)\n/);
    for (const line of out.split("\n")) expect(line.length, line).toBeLessThanOrEqual(80);
  });

  it("shows skipped trials hollow in the HTML report, with verdicts, a flaky section and the skipped errors", async () => {
    const html = renderHtml(await run());
    const script = html.slice(html.indexOf("<script>") + "<script>".length, html.indexOf("</script>"));
    const elements = new Map<string, { innerHTML: string; textContent: string; scrollIntoView(): void }>();
    const document = {
      getElementById: (id: string) => {
        if (!elements.has(id)) elements.set(id, { innerHTML: "", textContent: "", scrollIntoView() {} });
        return elements.get(id)!;
      },
    };
    vm.runInContext(script, vm.createContext({ document }));
    const shown = (id: string) => elements.get(id)!.innerHTML;
    expect(shown("tasks")).toContain('class="dot skip" title="trial 3: skipped"');
    expect(shown("tasks")).toContain(">flaky</span><div class='meta' title='95% Wilson interval for the pass rate of the graded trials'>95% 21%–94%</div>");
    expect(shown("kpis")).toContain("<b>100.0%</b><span>pass@3</span>");
    expect(shown("kpis")).toContain("<b>2</b><span>trials skipped</span>");
    expect(shown("flaky")).toContain("<td><b>book-at-posted-rate</b></td><td>2 of 3</td><td>21%–94%</td>");
    expect(shown("skipped")).toContain("<td>2×</td><td>429 Too Many Requests</td>");
    // A skipped trial's error is not a failed check of its task.
    expect(shown("tasks")).not.toContain('<span class="chip">runtime</span>');
  });
});

describe("`run` with a skipped trial", () => {
  it.skipIf(!process.features.typescript)("exits 2 and says the run is incomplete, even without --fail-under", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sandtable-skipped-"));
    const agent = path.join(dir, "agent.mjs");
    const demo = path.resolve("src/demo/freight-agents.ts");
    writeFileSync(
      agent,
      `import { freightScriptedAgent } from ${JSON.stringify(demo)};
const careful = freightScriptedAgent("careful");
export default {
  name: "flaky-host",
  async createSession(input) {
    if (input.sessionId.endsWith("/no-mc-number#0")) throw new Error("429 Too Many Requests");
    return careful.createSession(input);
  },
};
`,
    );
    const args = [path.resolve("src/cli.ts"), "run", example, "--agent", agent, "--user", "scripted", "-t", "book-at-posted-rate,no-mc-number", "--no-html", "-o", path.join(dir, "out")];
    const err = await promisify(execFile)(process.execPath, args).then(
      () => undefined,
      (e: { code: number; stdout: string; stderr: string }) => e,
    );
    expect(err?.code).toBe(2);
    expect(err?.stderr).toContain("1 of 2 trial(s) ended in an error before the agent broke any rule, so they were skipped and this run is incomplete");
    expect(err?.stderr).toContain("429 Too Many Requests");
    expect(err?.stderr).not.toContain("Every trial ended in an error");
    // The graded trial passed, so pass^1 is 100% over it.
    expect(plain(err?.stdout ?? "")).toContain("pass^1 100.0%");
  });
});

describe("pass^k", () => {
  it("still averages over tasks with at least k trials", () => {
    expect(passHatK([[true, true], [true]], 2)).toBe(1);
  });
});
