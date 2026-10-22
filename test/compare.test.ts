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
import { baselineSnapshot, compareRuns, regressions } from "../src/run/compare.ts";
import { regradeSuite } from "../src/run/regrade.ts";
import { runSuite, type SuiteResult } from "../src/run/suite.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import { loadDomain } from "../src/spec/load.ts";
import type { Domain } from "../src/spec/schema.ts";

const example = path.resolve("examples/freight");
const cli = path.resolve("src/cli.ts");
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * A run with the given verdicts per task, e.g. { a: [true, false] }; enough for comparing. Each task carries the
 * same `inputs` and `grading` hashes in every fake run unless `tests` overrides them, or `perTask: false`
 * leaves them out, as in results written before per-task hashes.
 */
function fake(
  verdicts: Record<string, boolean[]>,
  over: Partial<SuiteResult> = {},
  opts: { perTask?: boolean; tests?: Record<string, { inputs?: string; grading?: string }> } = {},
): SuiteResult {
  const tasks = Object.entries(verdicts).map(([id, v]) => ({
    id, tags: [], passes: v.filter(Boolean).length,
    ...(opts.perTask === false ? {} : { inputs: `in-${id}`, grading: `gr-${id}`, ...opts.tests?.[id] }),
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
    expect(baselineSnapshot(now).tasks).toEqual([
      { id: "kept", passes: 1, trials: 1, inputs: "in-kept", grading: "gr-kept" },
      { id: "outage", passes: 0, trials: 0, inputs: "in-outage", grading: "gr-outage" },
    ]);
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

  it("with a baseline from before per-task hashes, says so, and names changed prompts only when both runs ran the same tasks with the same caller", () => {
    const NOTE = "the baseline has no per-task fingerprints: a changed test looks like a fix";
    const base = baselineSnapshot(fake({ t: [true] }, { agent: "scripted:careful", inputs: "old" }, { perTask: false }));
    expect(compareRuns(base, fake({ t: [true] }, { agent: "scripted:naive", inputs: "new" })).differences).toEqual([
      "agent scripted:careful → scripted:naive",
      NOTE,
      "prompts changed: the policy, a tool's schema or a task's caller prompt",
    ]);
    // Another caller, or other tasks, change the run's fingerprint by themselves: nothing more to say.
    expect(compareRuns(base, fake({ t: [true] }, { agent: "scripted:careful", user: "scripted", inputs: "new" })).differences).toEqual(["simulated user u → scripted", NOTE]);
    expect(compareRuns(base, fake({ t: [true], s: [true] }, { agent: "scripted:careful", inputs: "new" })).differences).toEqual([NOTE]);
    // A baseline from before the run's fingerprint has nothing to compare it with either.
    const { inputs: _, ...old } = base;
    expect(compareRuns(old, fake({ t: [true] }, { agent: "scripted:careful", inputs: "new" })).differences).toEqual([NOTE]);
    // Old baselines keep today's verdicts: a task whose test changed still reads as fixed.
    expect(compareRuns(baselineSnapshot(fake({ t: [false] }, {}, { perTask: false })), fake({ t: [true] }, {}, { tests: { t: { inputs: "edited" } } })).tasks[0]).toMatchObject({ change: "fixed" });
  });

  it("counts only broken tasks as regressions: not worse, changed, added, removed or skipped ones", () => {
    const before = fake({ broke: [true, true], worse: [true, false, true], changed: [true, true], gone: [true], crashed: [true], kept: [true] }, { k: 3 });
    const now = fake(
      { broke: [true, false], worse: [false, false, true], changed: [false, false], added: [false], crashed: [], kept: [true] },
      { k: 3 },
      { tests: { changed: { grading: "edited" } } },
    );
    const c = compareRuns(baselineSnapshot(before), now);
    expect(c.tasks.map((d) => [d.id, d.change])).toEqual(expect.arrayContaining([["worse", "worse"], ["changed", "changed"], ["added", "added"], ["gone", "removed"], ["crashed", "skipped"]]));
    expect(regressions(c).map((d) => d.id)).toEqual(["broke"]);
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

describe("a task whose test changed since the baseline", () => {
  const ids = ["book-at-posted-rate", "expired-insurance", "walk-away-above-ceiling"];
  const careful = (domain: Domain, taskIds: string[]) =>
    runSuite({ domain, agent: freightScriptedAgent("careful"), user: scriptedUser(), taskIds }).then((r) => JSON.parse(JSON.stringify(r)) as SuiteResult);
  const edit = (domain: Domain, id: string, change: (t: Domain["tasks"][number]) => Domain["tasks"][number]): Domain => ({
    ...domain,
    tasks: domain.tasks.map((t) => (t.id === id ? change(t) : t)),
  });

  it("is labelled changed, with what changed, and left out of pass^k, even when the runs ran other tasks", async () => {
    const domain = await loadDomain(example);
    const before = await careful(domain, ids);
    // The issue's case: one task's caller is given something else, another's expectations change, and a task is added.
    let edited = edit(domain, "book-at-posted-rate", (t) => ({ ...t, user: { ...t.user, script: [...t.user.script!.slice(0, -1), "Thanks, that's all. Bye."] } }));
    edited = edit(edited, "expired-insurance", (t) => ({ ...t, expect: { ...t.expect, called: ["verify_carrier"] } }));
    const now = await careful(edited, [...ids, "inactive-authority"]);
    const c = compareRuns(baselineSnapshot(before), now);
    const byId = Object.fromEntries(c.tasks.map((d) => [d.id, d]));
    expect(byId["book-at-posted-rate"]).toMatchObject({ change: "changed", what: ["inputs"] });
    expect(byId["expired-insurance"]).toMatchObject({ change: "changed", what: ["grading"] });
    expect(byId["walk-away-above-ceiling"]).toMatchObject({ change: "same" });
    expect(byId["walk-away-above-ceiling"]!.what).toBeUndefined();
    expect(byId["inactive-authority"]).toMatchObject({ change: "added" });
    // The task sets differ, and the run still says what changed.
    expect(c.sameTasks).toBe(false);
    expect(c.differences).toEqual(["what the agent or caller is given changed for 1 task", "how it's graded changed for 1 task"]);
    expect(c.shared).toBe(3);
    expect(c.comparable).toBe(1);
    const lines = plain(renderTerminal({ ...now, baseline: baselineSnapshot(before) })).split("\n");
    const block = lines.slice(lines.findIndex((l) => l.startsWith("  Compared with")));
    expect(block).toContain("  ! what the agent or caller is given changed for 1 task");
    expect(block.some((l) => /^ {2}~ changed book-at-posted-rate +1\/1 → 1\/1 +inputs$/.test(l))).toBe(true);
    expect(block.some((l) => /^ {2}~ changed expired-insurance +1\/1 → 1\/1 +grading$/.test(l))).toBe(true);
    expect(block).toContain("  ~ changed: its prompts, tools, world or grading differ from the baseline's");
    expect(block).toContain("  over the 1 task both runs ran with the same test (2 changed left out):");
    for (const line of block) expect(line.length, line).toBeLessThanOrEqual(80);
  });

  it("covers every task when a rule, a seed row or a tool changes, and not when a draft is accepted", async () => {
    const domain = await loadDomain(example);
    const before = await careful(domain, ids);
    const changes = async (edited: Domain) => compareRuns(baselineSnapshot(before), await careful(edited, ids)).tasks.map((d) => d.what?.join() ?? d.change);
    // A rule made soft changes how every task is graded: a call to any tool can trip a rule.
    const soft: Domain = { ...domain, invariants: domain.invariants.map((inv, i) => (i === 0 ? { ...inv, soft: true } : inv)) };
    expect(await changes(soft)).toEqual(["grading", "grading", "grading"]);
    // A seed row is part of the world every task acts in.
    const rows: Domain = { ...domain, world: { tables: { ...domain.world.tables, loads: { ...domain.world.tables.loads!, rows: domain.world.tables.loads!.rows.slice(0, -1) } } } };
    expect(await changes(rows)).toEqual(["inputs", "inputs", "inputs"]);
    // Accepting a drafted rule or tool records a review, not a change to the test.
    const accepted: Domain = {
      ...domain,
      tools: domain.tools.map((t) => ({ ...t, review: "accepted" as const })),
      invariants: domain.invariants.map((inv) => ({ ...inv, review: "accepted" as const, description: `${inv.description} (reviewed)` })),
    };
    expect(await changes(accepted)).toEqual(["same", "same", "same"]);
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

  it("labels a task whose test changed neutrally, with what changed, and leaves it out of the scores", () => {
    const before = fake({ kept: [true], edited: [false] });
    const now = fake({ kept: [true], edited: [true] }, {}, { tests: { edited: { grading: "new" } } });
    const section = page(renderHtml({ ...now, baseline: baselineSnapshot(before) }))("baseline");
    expect(section).toContain("<td class='meta'>test changed (how it's graded)</td><td><code>edited</code></td><td>0/1</td><td class='meta'>1/1</td>");
    expect(section).toContain("Score (over the 1 task both runs ran with the same test; 1 changed left out)");
    expect(section).toContain("<li>how it's graded changed for 1 task</li>");
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
    // The new invariant changed how every task is graded since the baseline, so the regraded run reads its moves as
    // a changed test, not as the agent breaking them, and has no task left to compare pass^k over.
    const c = compareRuns(regraded.baseline!, regraded);
    expect(c.tasks.every((d) => d.change === "changed" && d.what?.join() === "grading")).toBe(true);
    expect(c.tasks.filter((d) => d.after!.passes < d.before!.passes).map((d) => d.id)).toEqual(reefer);
    expect(c.differences).toEqual([`how it's graded changed for ${careful.tasks.length} tasks`]);
    expect(c.comparable).toBe(0);
    const text = plain(renderTerminal(regraded));
    expect(text).toMatch(/~ changed equipment-mismatch +1\/1 → 0\/1 +grading/);
    expect(text).toContain("every task both runs ran has a changed test, so there is no pass^k to compare");
    expect(text).not.toContain("✗ broken");
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

  it.skipIf(!process.features.typescript)("sandtable run --fail-on-regression exits 1 when a task broke since the baseline, and names it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-regression-"));
    const exec = (...args: string[]) =>
      promisify(execFile)(process.execPath, [cli, ...args]).then((r) => ({ code: 0, ...r }), (e: { code: number; stdout: string; stderr: string }) => e);
    const run = (agent: string, out: string, ...more: string[]) => exec("run", example, "--agent", agent, "--user", "scripted", "-t", "book-at-posted-rate", "-o", path.join(dir, out), "--no-html", ...more);
    await run("scripted:careful", "careful");
    const base = path.join(dir, "careful", "results.json");

    // The naive agent breaks the booking: reported either way, a failed gate only under the flag.
    expect((await run("scripted:naive", "naive", "--baseline", base)).code).toBe(0);
    const gated = await run("scripted:naive", "naive-gated", "--baseline", base, "--fail-on-regression");
    expect(gated.code).toBe(1);
    expect(gated.stderr).toContain("✗ 1 task(s) broke since the baseline (--fail-on-regression): book-at-posted-rate 1/1 → 0/1");
    // Nothing broke: the gate passes.
    const same = await run("scripted:careful", "careful-again", "--baseline", base, "--fail-on-regression");
    expect(same.code).toBe(0);
    expect(same.stderr).not.toContain("--fail-on-regression");
  });

  it.skipIf(!process.features.typescript)("sandtable run --fail-on-regression without --baseline is a usage error, before any trial runs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-regression-"));
    const out = path.join(dir, "out");
    const err = await promisify(execFile)(process.execPath, [cli, "run", example, "--agent", "scripted:careful", "--user", "scripted", "-o", out, "--fail-on-regression"]).catch((e: { code: number; stdout: string; stderr: string }) => e);
    expect(err).toMatchObject({ code: 2, stdout: "" });
    expect((err as { stderr: string }).stderr).toContain("error: --fail-on-regression needs --baseline <results>");
    expect(await stat(out).catch(() => undefined)).toBeUndefined();
  });

  it.skipIf(!process.features.typescript)("sandtable compare prints what run --baseline would have, from two stored runs, and writes nothing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-compare-"));
    const exec = (...args: string[]) =>
      promisify(execFile)(process.execPath, [cli, ...args]).then((r) => ({ code: 0, ...r }), (e: { code: number; stdout: string; stderr: string }) => e);
    const run = (agent: string, out: string, ...more: string[]) => exec("run", example, "--agent", agent, "--user", "scripted", "-t", "book-at-posted-rate,no-mc-number", "-o", path.join(dir, out), "--no-html", ...more);
    await run("scripted:careful", "careful");
    const base = path.join(dir, "careful", "results.json");
    const live = plain((await run("scripted:naive", "naive-live", "--baseline", base)).stdout);
    await run("scripted:naive", "naive");
    const now = path.join(dir, "naive", "results.json");
    const before = await readFile(now, "utf8");

    const compared = await exec("compare", base, now);
    expect(compared.code).toBe(0);
    const text = plain(compared.stdout);
    expect(text.split("\n")[0]).toContain(`sandtable compare · freight-carrier-sales · ${now}`);
    // The same block as the live run's, from "Compared with" on.
    const block = (t: string) => t.slice(t.indexOf(`  Compared with ${base}`)).split("\n\n  results:")[0]!.trimEnd();
    expect(block(text)).toBe(block(live));
    expect(block(text)).toMatch(/✗ broken {2}book-at-posted-rate {2}1\/1 → 0\/1/);
    expect(await readFile(now, "utf8")).toBe(before);

    const gated = await exec("compare", base, now, "--fail-on-regression");
    expect(gated.code).toBe(1);
    expect(gated.stderr).toContain("✗ 1 task(s) broke since the baseline (--fail-on-regression): book-at-posted-rate 1/1 → 0/1");
    expect((await exec("compare", base, base, "--fail-on-regression")).code).toBe(0);

    // -o writes the newer run with the baseline attached, as run --baseline would have.
    const out = path.join(dir, "compared");
    expect((await exec("compare", base, now, "-o", out)).code).toBe(0);
    const written = JSON.parse(await readFile(path.join(out, "results.json"), "utf8")) as SuiteResult;
    expect(written.baseline).toEqual(baselineSnapshot(JSON.parse(await readFile(base, "utf8")) as SuiteResult));
    expect(written.runId).toBe((JSON.parse(before) as SuiteResult).runId);
    expect(await readFile(path.join(out, "report.html"), "utf8")).toContain('"change":"broken"');
  });

  it.skipIf(!process.features.typescript)("sandtable compare refuses runs of two domains, and a file that isn't a results.json", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-compare-"));
    const freight = path.join(dir, "freight.json");
    const clinic = path.join(dir, "clinic.json");
    await writeFile(freight, JSON.stringify(fake({ t: [true] }, { domain: "freight-carrier-sales" })));
    await writeFile(clinic, JSON.stringify(fake({ t: [true] }, { domain: "clinic-front-desk" })));
    const fail = (...args: string[]) => promisify(execFile)(process.execPath, [cli, "compare", ...args]).catch((e: { code: number; stdout: string; stderr: string }) => e);
    const other = await fail(freight, clinic);
    expect(other).toMatchObject({ code: 2, stdout: "" });
    expect((other as { stderr: string }).stderr).toContain(`${freight} and ${clinic} are runs of different domains, freight-carrier-sales and clinic-front-desk: compare two runs of the same domain`);
    await writeFile(clinic, JSON.stringify({ rows: [] }));
    expect(((await fail(freight, clinic)) as { stderr: string }).stderr).toContain(`${clinic} is not a results.json written by \`sandtable run\`; it is a leaderboard's leaderboard.json`);
    expect(((await fail(freight, path.join(dir, "nope.json"))) as { code: number; stderr: string })).toMatchObject({ code: 2 });
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
