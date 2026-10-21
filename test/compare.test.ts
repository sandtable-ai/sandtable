import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { freightScriptedAgent } from "../src/demo/freight-agents.ts";
import { renderHtml } from "../src/report/html.ts";
import { renderTerminal } from "../src/report/terminal.ts";
import { baselineSnapshot, compareRuns } from "../src/run/compare.ts";
import { regradeSuite } from "../src/run/regrade.ts";
import { runSuite, type SuiteResult } from "../src/run/suite.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import { loadDomain } from "../src/spec/load.ts";
import type { Domain } from "../src/spec/schema.ts";

const example = path.resolve("examples/freight");
const cli = path.resolve("src/cli.ts");
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** A run with the given verdicts per task, e.g. { a: [true, false] }; enough for comparing. */
function fake(verdicts: Record<string, boolean[]>, over: Partial<SuiteResult> = {}): SuiteResult {
  const tasks = Object.entries(verdicts).map(([id, v]) => ({
    id, tags: [], passes: v.filter(Boolean).length,
    trials: v.map((passed, trial) => ({ taskId: id, trial, passed, checks: [], violations: [], soft: [], events: [], changes: [], endReason: "user_stop" as const, turns: 1, durationMs: 0, usage: { agent: {}, user: {}, costUsd: 0 } })),
  }));
  const k = Math.max(...Object.values(verdicts).map((v) => v.length));
  return {
    version: 1, runId: "run-now", domain: "d", agent: "a", user: "u", k, inputs: "same", startedAt: "2026-10-21T00:00:00.000Z", durationMs: 0, tasks, passHat: {},
    failureModes: [], byTag: [], soft: [], usage: { agent: {}, user: {}, costUsd: 0 }, pendingReview: [], latency: { agentTurnP50Ms: null, agentTurnP95Ms: null }, ...over,
  };
}

async function stored(domain: Domain, mode: "careful" | "naive"): Promise<SuiteResult> {
  const result = await runSuite({ domain, agent: freightScriptedAgent(mode), user: scriptedUser() });
  return JSON.parse(JSON.stringify(result)) as SuiteResult;
}

describe("compareRuns", () => {
  it("sorts every task into broken, worse, fixed, better, added, removed and same, regressions first", () => {
    const before = fake({ kept: [true, true], breaks: [true, true], dips: [true, false], fixes: [false, true], rises: [false, false], gone: [true, true] });
    const now = fake({ kept: [true, true], breaks: [true, false], dips: [false, false], fixes: [true, true], rises: [true, false], fresh: [false, false] });
    const c = compareRuns(baselineSnapshot(before), now);
    expect(c.tasks.map((d) => [d.change, d.id])).toEqual([
      ["broken", "breaks"], ["worse", "dips"], ["fixed", "fixes"], ["better", "rises"], ["added", "fresh"], ["removed", "gone"], ["same", "kept"],
    ]);
    expect(c.tasks.find((d) => d.id === "breaks")).toEqual({ id: "breaks", change: "broken", before: { passes: 2, trials: 2 }, after: { passes: 1, trials: 2 } });
    expect(c.tasks.find((d) => d.id === "fresh")).toEqual({ id: "fresh", change: "added", after: { passes: 0, trials: 2 } });
    expect(c.tasks.find((d) => d.id === "gone")).toEqual({ id: "gone", change: "removed", before: { passes: 2, trials: 2 } });
    // pass^j over the five tasks both runs ran: 6 of 10 trials passed before, 6 of 10 now.
    expect(c.sameTasks).toBe(false);
    expect(c.shared).toBe(5);
    expect(c.passHat.map((p) => p.j)).toEqual([1, 2]);
    expect(c.passHat[0]).toMatchObject({ before: 0.6, after: 0.6 });
    expect(c.passHat[1]).toMatchObject({ before: 0.4, after: 0.4 });
    expect(c.differences).toEqual([]);
  });

  it("counts graded trials only, and calls a task with none graded in one run skipped, not broken", () => {
    const skip = (r: SuiteResult, id: string, trial: number): SuiteResult => {
      const tasks = r.tasks.map((t) => {
        if (t.id !== id) return t;
        const trials = t.trials.map((tr) => (tr.trial === trial ? { ...tr, passed: false, skipped: true as const, endReason: "error" as const, error: "429" } : tr));
        const graded = trials.filter((tr) => !tr.skipped).length;
        return { ...t, trials, passes: trials.filter((tr) => tr.passed).length, graded, skipped: trials.length - graded };
      });
      return { ...r, tasks };
    };
    const before = fake({ kept: [true, true], outage: [true, true] });
    // `kept` passed its one graded trial, so it is unchanged; every trial of `outage` was skipped.
    const now = skip(skip(skip(fake({ kept: [true, true], outage: [true, true] }), "kept", 1), "outage", 0), "outage", 1);
    const c = compareRuns(baselineSnapshot(before), now);
    expect(c.tasks).toEqual([
      { id: "outage", change: "skipped", before: { passes: 2, trials: 2 }, after: { passes: 0, trials: 0 } },
      { id: "kept", change: "same", before: { passes: 2, trials: 2 }, after: { passes: 1, trials: 1 } },
    ]);
    expect(baselineSnapshot(now).tasks).toEqual([{ id: "kept", passes: 1, trials: 1 }, { id: "outage", passes: 0, trials: 0 }]);
    expect(plain(renderTerminal({ ...now, baseline: baselineSnapshot(before) }))).toContain("  ○ 1 not graded in one of the runs (outage)");
  });

  it("compares pass^j only up to the smaller k, and says k changed", () => {
    const c = compareRuns(baselineSnapshot(fake({ t: [true, true, true, false] })), fake({ t: [true, false] }));
    expect(c.passHat.map((p) => p.j)).toEqual([1, 2]);
    expect(c.passHat[0]).toMatchObject({ before: 0.75, after: 0.5 });
    expect(c.passHat[1]!.before).toBeCloseTo(0.5);
    expect(c.passHat[1]!.after).toBe(0);
    expect(c.tasks[0]).toMatchObject({ change: "worse" });
    expect(c.differences).toEqual(["k 4 → 2: pass^j compared up to j=2"]);
  });

  it("names a changed agent and caller, and changed prompts only when both runs ran the same tasks with the same caller", () => {
    const base = baselineSnapshot(fake({ t: [true] }, { agent: "scripted:careful", inputs: "old" }));
    expect(compareRuns(base, fake({ t: [true] }, { agent: "scripted:naive", inputs: "new" })).differences).toEqual([
      "agent scripted:careful → scripted:naive",
      "prompts changed: the policy, a tool's schema or a task's caller prompt",
    ]);
    // Another caller, or other tasks, change the fingerprint by themselves: nothing more to say.
    expect(compareRuns(base, fake({ t: [true] }, { agent: "scripted:careful", user: "scripted", inputs: "new" })).differences).toEqual(["simulated user u → scripted"]);
    expect(compareRuns(base, fake({ t: [true], s: [true] }, { agent: "scripted:careful", inputs: "new" })).differences).toEqual([]);
    // A baseline from before the fingerprint has nothing to compare it with.
    const { inputs: _, ...old } = base;
    expect(compareRuns(old, fake({ t: [true] }, { agent: "scripted:careful", inputs: "new" })).differences).toEqual([]);
  });

  it("lists every freight task the naive agent broke against the careful one", async () => {
    const domain = await loadDomain(example);
    const careful = await stored(domain, "careful");
    const naive = await stored(domain, "naive");
    const c = compareRuns(baselineSnapshot(careful), naive);
    const failing = naive.tasks.filter((t) => t.passes === 0).map((t) => t.id);
    expect(c.tasks.filter((d) => d.change === "broken").map((d) => d.id)).toEqual(failing);
    expect(c.tasks.filter((d) => d.change === "same")).toHaveLength(50 - failing.length);
    expect(c.sameTasks).toBe(true);
    expect(c.passHat).toEqual([{ j: 1, before: careful.passHat["1"], after: naive.passHat["1"] }]);
    expect(c.differences).toEqual(["agent scripted:careful → scripted:naive"]);
  });
});

describe("terminal comparison", () => {
  it("ends the summary with what changed, inside 80 columns, regressions first", async () => {
    const domain = await loadDomain(example);
    const careful = await stored(domain, "careful");
    const naive = await stored(domain, "naive");
    const lines = plain(renderTerminal({ ...naive, baseline: baselineSnapshot(careful) }, { baseline: "base/results.json" })).split("\n");
    const block = lines.slice(lines.indexOf("  Compared with base/results.json"));
    expect(block[1]).toBe(`  run ${careful.runId} · started ${careful.startedAt}`);
    expect(block[2]).toBe("  ! agent scripted:careful → scripted:naive");
    expect(block[4]).toMatch(/^ {2}✗ broken {2}book-at-posted-rate +1\/1 → 0\/1$/);
    expect(block.filter((l) => l.startsWith("  ✗ broken"))).toHaveLength(45);
    expect(block).toContain("  = 5 unchanged");
    expect(block.at(-1)).toBe("  pass^1 100.0% → 10.0%  (−90.0 pts)");
    for (const line of block) expect(line.length, line).toBeLessThanOrEqual(80);
    // Without a baseline, the summary ends as before.
    expect(plain(renderTerminal(naive))).not.toContain("Compared with");
  });

  it("counts added and removed tasks, failing added ones first, and scores over the shared tasks", () => {
    const before = fake({ kept: [true], fixes: [false], gone: [true], "also-gone": [false] });
    const now = fake({ kept: [true], fixes: [true], "new-pass": [true], "new-fail": [false] });
    const text = plain(renderTerminal({ ...now, baseline: baselineSnapshot(before) }));
    const block = text.slice(text.indexOf("  Compared with the baseline run")).split("\n");
    expect(block).toEqual([
      "  Compared with the baseline run",
      "  run run-now · started 2026-10-21T00:00:00.000Z",
      "  same agent, simulated user and k",
      "",
      "  ✓ fixed   fixes  0/1 → 1/1",
      "  + 2 added, 1 failing (new-fail, new-pass)",
      "  − 2 only in the baseline (gone, also-gone)",
      "  = 1 unchanged",
      "",
      "  over the 2 tasks both runs ran:",
      "  pass^1 50.0% → 100.0%  (+50.0 pts)",
    ]);
  });
});

describe("HTML comparison", () => {
  /** Run the report's script against a stand-in for the page, and return each element's HTML. */
  function page(html: string): (id: string) => string {
    const script = html.slice(html.indexOf("<script>") + "<script>".length, html.indexOf("</script>"));
    const elements = new Map<string, { innerHTML: string; textContent: string; scrollIntoView(): void }>();
    const document = {
      getElementById: (id: string) => {
        if (!elements.has(id)) elements.set(id, { innerHTML: "", textContent: "", scrollIntoView() {} });
        return elements.get(id)!;
      },
    };
    vm.runInContext(script, vm.createContext({ document }));
    return (id) => elements.get(id)?.innerHTML ?? "";
  }

  it("shows the changes since the baseline near the top, regressions first, and marks regressed tasks", () => {
    const before = fake({ kept: [true], breaks: [true], fixes: [false] }, { runId: "base-run" });
    const now = fake({ kept: [true], breaks: [false], fixes: [true] });
    const html = renderHtml({ ...now, baseline: baselineSnapshot(before) });
    expect(html.indexOf('<div id="baseline">')).toBeLessThan(html.indexOf("<h2>Tasks</h2>"));
    const el = page(html);
    const section = el("baseline");
    expect(section).toContain("<h2>Changes since baseline</h2>");
    expect(section).toContain("Compared with run <code>base-run</code>");
    expect(section).toContain("<tr><td>pass^1</td><td>66.7%</td><td>66.7%</td><td class=''>no change</td></tr>");
    expect(section.indexOf("<code>breaks</code>")).toBeLessThan(section.indexOf("<code>fixes</code>"));
    expect(section).toContain("<td class='badt'><b>broken</b></td><td><code>breaks</code></td><td>1/1</td><td class='badt'>0/1</td>");
    expect(section).toContain("1 task unchanged.");
    const rows = el("tasks").split("<tr>");
    expect(rows.find((r) => r.includes("<b>breaks</b>"))).toContain('<span class="chip regressed">broken since baseline</span>');
    expect(rows.find((r) => r.includes("<b>fixes</b>"))).not.toContain("since baseline");
  });

  it("has no comparison section for a run without a baseline", () => {
    expect(page(renderHtml(fake({ t: [true] })))("baseline")).toBe("");
  });
});

describe("regrade and report keep the comparison", () => {
  it("regrade compares the re-scored trials with the stored baseline", async () => {
    const domain = await loadDomain(example);
    const careful = await stored(domain, "careful");
    const run = { ...careful, baseline: baselineSnapshot(careful) };
    expect(compareRuns(run.baseline, run).tasks.every((d) => d.change === "same")).toBe(true);
    const edited: Domain = {
      ...domain,
      invariants: [...domain.invariants, { id: "no-reefer-bookings", description: "Never book a reefer load.", never: { tool: "book_load", when: { load_id: "L-1005" } } }],
    };
    const regraded = regradeSuite(edited, run);
    expect(regraded.baseline).toEqual(run.baseline);
    const reefer = careful.tasks.filter((t) => t.trials[0]!.events.some((e) => e.type === "tool" && e.name === "book_load" && (e.args as { load_id?: string }).load_id === "L-1005")).map((t) => t.id);
    expect(reefer).toContain("equipment-mismatch");
    expect(compareRuns(regraded.baseline!, regraded).tasks.filter((d) => d.change === "broken").map((d) => d.id)).toEqual(reefer);
    expect(plain(renderTerminal(regraded))).toMatch(/✗ broken {2}equipment-mismatch +1\/1 → 0\/1/);
  });

  it.skipIf(!process.features.typescript)("sandtable run --baseline stores the baseline, and report re-renders the changes without the old file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-baseline-"));
    const exec = (...args: string[]) => promisify(execFile)(process.execPath, [cli, ...args]);
    await exec("run", example, "--agent", "scripted:careful", "--user", "scripted", "-t", "book-at-posted-rate,no-mc-number", "-o", path.join(dir, "careful"), "--no-html");
    const base = path.join(dir, "careful", "results.json");
    const { stdout } = await exec("run", example, "--agent", "scripted:naive", "--user", "scripted", "-t", "book-at-posted-rate,no-mc-number", "-o", path.join(dir, "naive"), "--baseline", base, "--no-html");
    expect(plain(stdout)).toContain(`Compared with ${base}`);
    expect(plain(stdout)).toMatch(/✗ broken {2}book-at-posted-rate {2}1\/1 → 0\/1/);
    const result = JSON.parse(await readFile(path.join(dir, "naive", "results.json"), "utf8")) as SuiteResult;
    const careful = JSON.parse(await readFile(base, "utf8")) as SuiteResult;
    expect(result.baseline).toEqual(baselineSnapshot(careful));

    await writeFile(base, "gone");
    await exec("report", path.join(dir, "naive", "results.json"));
    const html = await readFile(path.join(dir, "naive", "report.html"), "utf8");
    expect(html).toContain(`const C = {"baseline":{"runId":"${careful.runId}"`);
    expect(html).toContain('{"id":"book-at-posted-rate","change":"broken","before":{"passes":1,"trials":1},"after":{"passes":0,"trials":1}}');
  });

  it.skipIf(!process.features.typescript)("sandtable run --baseline refuses another domain's run before any trial runs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-baseline-"));
    const base = path.join(dir, "freight.json");
    await writeFile(base, JSON.stringify(fake({ t: [true] }, { domain: "freight-carrier-sales" })));
    const out = path.join(dir, "out");
    const err = await promisify(execFile)(process.execPath, [cli, "run", "examples/clinic", "--agent", "scripted:clinic-careful", "--user", "scripted", "-o", out, "--baseline", base]).catch((e: { code: number; stdout: string; stderr: string }) => e);
    expect(err).toMatchObject({ code: 2, stdout: "" });
    expect((err as { stderr: string }).stderr).toContain(`${base} is a run of freight-carrier-sales, not clinic-front-desk, so it can't be this run's baseline: pass a results.json of clinic-front-desk`);
    expect(await stat(out).catch(() => undefined)).toBeUndefined();

    await writeFile(base, JSON.stringify({ rows: [] }));
    const lb = await promisify(execFile)(process.execPath, [cli, "run", "examples/clinic", "--agent", "scripted:clinic-careful", "--user", "scripted", "-o", out, "--baseline", base]).catch((e: { code: number; stderr: string }) => e);
    expect((lb as { stderr: string }).stderr).toContain("is not a results.json written by `sandtable run`; it is a leaderboard's leaderboard.json");
    expect(await stat(out).catch(() => undefined)).toBeUndefined();
  });
});
