import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { freightScriptedAgent } from "../src/demo/freight-agents.ts";
import { withJudgedSummary, type JudgedVerdict } from "../src/judge/summary.ts";
import { renderMarkdown } from "../src/report/markdown.ts";
import { baselineSnapshot } from "../src/run/compare.ts";
import { runSuite, type SuiteResult } from "../src/run/suite.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import { loadDomain } from "../src/spec/load.ts";

// `report --markdown` (#495): a run's summary for a CI job summary or a pull request comment. These check the lines,
// not a snapshot of the whole file.

const example = path.resolve("examples/freight");
const cli = path.resolve("src/cli.ts");
const COMMENT_LIMIT = 65_536;

type Outcome = boolean | "skipped";

/** A task with these outcomes per trial, whose failed trials failed `failed`. */
function task(id: string, outcomes: Outcome[], failed: string[] = ["a-check"], over: Partial<SuiteResult["tasks"][number]> = {}): SuiteResult["tasks"][number] {
  const passes = outcomes.filter((o) => o === true).length;
  const graded = outcomes.filter((o) => o !== "skipped").length;
  return {
    ...over, id, tags: [], passes, graded, inputs: `in-${id}`, grading: `gr-${id}`,
    verdict: graded === 0 ? "skipped" : passes === graded ? "passed" : passes === 0 ? "failed" : "flaky",
    ...(graded < outcomes.length ? { skipped: outcomes.length - graded } : {}),
    trials: outcomes.map((o, trial) => ({
      taskId: id, trial, passed: o === true, ...(o === "skipped" ? { skipped: true as const, error: "the endpoint went down" } : {}),
      checks: o === false ? failed.map((c) => ({ id: c, kind: "invariant", passed: false, detail: "broke it" })) : [],
      violations: [], soft: [], events: [], changes: [], endReason: "user_stop", turns: 1, durationMs: 0,
      usage: { agent: {}, user: {}, costUsd: 0 },
    })),
  } as unknown as SuiteResult["tasks"][number];
}

/** A run of these tasks, with pass^1 and pass^k as given. */
function run(tasks: SuiteResult["tasks"], over: Partial<SuiteResult> = {}): SuiteResult {
  const k = Math.max(...tasks.map((t) => t.trials.length));
  return {
    version: 1, sandtable: { version: "1.4.0" }, runId: "run-now", domain: "freight", agent: "scripted:naive", user: "scripted", k, inputs: "same",
    startedAt: "2026-10-21T00:00:00.000Z", durationMs: 0, tasks, passHat: { "1": 0.5, [String(k)]: 0.25 },
    failureModes: [], byTag: [], soft: [], usage: { agent: {}, user: {}, costUsd: 0 }, pendingReview: [], latency: { agentTurnP50Ms: null, agentTurnP95Ms: null }, ...over,
  } as SuiteResult;
}

const lines = (md: string) => md.split("\n");
/** The lines of the section under this heading, up to the next heading. */
function section(md: string, heading: string): string[] {
  const all = lines(md);
  const at = all.indexOf(`### ${heading}`);
  if (at < 0) return [];
  const next = all.findIndex((l, i) => i > at && (l.startsWith("### ") || l.startsWith("Written by ")));
  return all.slice(at + 1, next < 0 ? undefined : next).filter(Boolean);
}
/** A table row's cells, keeping escaped pipes inside their cell. */
const cells = (row: string) => row.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());

describe("renderMarkdown", () => {
  it("opens with one line naming the domain, the agent, the simulated user and k, then pass^1 and pass^k", () => {
    const md = renderMarkdown(run([task("t", [true, false])]));
    expect(lines(md)[0]).toBe("### sandtable · `freight` · agent `scripted:naive` · user `scripted` · k=2");
    expect(lines(md)).toContain("- **pass^1** 50.0% · **pass^2** 25.0%");
    expect(md.endsWith("\n")).toBe(true);
  });

  it("shows pass^1 once at k=1, and a score a run couldn't work out as n/a", () => {
    const md = renderMarkdown(run([task("t", [true])], { passHat: { "1": null as unknown as number } }));
    expect(lines(md)).toContain("- **pass^1** n/a");
  });

  it("leaves out every section a run has nothing for", () => {
    const md = renderMarkdown(run([task("t", [true, true])]));
    expect(md).not.toMatch(/Changes since|Failed tasks|Top failure modes|Soft rules|Judged|Critical|Skipped|Floor|Provisional/);
  });

  it("says a run is provisional while drafted items are pending review", () => {
    const md = renderMarkdown(run([task("t", [true])], { pendingReview: [{ kind: "task", id: "d" }, { kind: "invariant", id: "e" }] as SuiteResult["pendingReview"] }));
    expect(lines(md)).toContain("- **Provisional:** 2 drafted item(s) are pending review");
  });

  it("says how the critical tasks did, naming the ones that failed", () => {
    const passed = renderMarkdown(run([task("a", [true], [], { critical: true }), task("b", [true], [], { critical: true }), task("c", [false])]));
    expect(lines(passed)).toContain("- **Critical tasks:** 2 of 2 passed every trial");
    const failed = renderMarkdown(run([task("a", [true], [], { critical: true }), task("b", [false], ["x"], { critical: true }), task("c", [true, false], ["x"], { critical: true })]));
    expect(lines(failed)).toContain("- **Critical tasks:** 1 of 3 passed every trial; these did not: `b`, `c`");
  });

  it("says how many trials were skipped, out of how many", () => {
    const md = renderMarkdown(run([task("a", [true, "skipped"]), task("b", ["skipped", "skipped"]), task("c", [true, true])]));
    expect(lines(md)).toContain("- **Skipped trials:** 3 of 6 ended in an error and are left out of the scores");
  });

  it("marks each floor met or not met, with the tag's score", () => {
    const md = renderMarkdown(
      run([task("t", [true, false])], {
        floors: { refusal: 1, negotiation: 0.7 },
        byTag: [{ tag: "refusal", tasks: 2, passHat1: 1, passHatK: 1 }, { tag: "negotiation", tasks: 3, passHat1: 0.5, passHatK: 1 / 3 }, { tag: "other", tasks: 1, passHat1: 1, passHatK: 1 }],
      }),
    );
    expect(lines(md)).toContain("- **Floor** `refusal` 100.0%: met (pass^2 100.0%)");
    expect(lines(md)).toContain("- **Floor** `negotiation` 70.0%: **not met** (pass^2 33.3%)");
    expect(md).not.toContain("`other`");
  });

  describe("with a baseline", () => {
    const before = run([task("kept", [true, true]), task("breaks", [true, true]), task("dips", [true, false]), task("fixes", [false, true]), task("rises", [false, false]), task("retest", [true, true]), task("gone", [true, true]), task("down", ["skipped", "skipped"])], { runId: "run-base", passHat: { "1": 0.6, "2": 0.4 } });
    const now = run(
      [task("kept", [true, true]), task("breaks", [true, false], ["verify-before-book"]), task("dips", [false, false]), task("fixes", [true, true]), task("rises", [true, false]), task("retest", [false, false]), task("fresh", [false, false]), task("down", [true, true])],
      { passHat: { "1": 0.5, "2": 0.25 } },
    );
    now.tasks[5]!.grading = "gr-edited";
    const md = renderMarkdown({ ...now, baseline: baselineSnapshot(before) });
    const moved = section(md, "Changes since the baseline");

    it("names the baseline and lists what moved, broken ones first", () => {
      expect(moved[0]).toBe("Compared with run `run-base`, started 2026-10-21T00:00:00.000Z.");
      const rows = moved.filter((l) => l.startsWith("| ") && !l.startsWith("| Change")).map(cells);
      expect(rows).toEqual([
        ["broken", "`breaks`", "2/2", "1/2"],
        ["worse", "`dips`", "1/2", "0/2"],
        ["fixed", "`fixes`", "1/2", "2/2"],
        ["better", "`rises`", "0/2", "1/2"],
        ["changed (grading)", "`retest`", "2/2", "0/2"],
      ]);
    });

    it("counts the tasks with nothing to compare", () => {
      expect(moved).toContain("1 added, 1 failing · 1 only in the baseline · 1 not graded in one of the runs · 1 unchanged");
    });

    it("gives pass^1 and pass^k before and after, as compare prints them", () => {
      expect(moved).toContain("Over the 6 tasks both runs ran with the same test (1 changed left out):");
      const scores = moved.filter((l) => l.startsWith("- **pass^"));
      expect(scores).toHaveLength(2);
      expect(scores[0]).toMatch(/^- \*\*pass\^1\*\* \d+\.\d% → \d+\.\d% \((no change|[+−]\d+\.\d pts)\)$/);
      expect(scores[1]).toMatch(/^- \*\*pass\^2\*\* /);
    });

    it("says what else differs between the runs, escaped", () => {
      const other = renderMarkdown({ ...run([task("t", [true])], { agent: "x|y" }), baseline: baselineSnapshot(run([task("t", [true])], { agent: "scripted:naive" })) });
      expect(section(other, "Changes since the baseline")).toContain("- agent scripted\\:naive → x\\|y");
    });

    it("says when no task can be compared", () => {
      const other = renderMarkdown({ ...run([task("a", [true])]), baseline: baselineSnapshot(run([task("b", [true])])) });
      expect(section(other, "Changes since the baseline")).toContain("No task ran in both runs, so there is no pass^k to compare.");
    });

    it("keeps pass^k's own line apart from the comparison's", () => {
      expect(lines(md).indexOf("- **pass^1** 50.0% · **pass^2** 25.0%")).toBeLessThan(lines(md).indexOf("### Changes since the baseline"));
    });
  });

  it("lists the failed tasks with their failed check ids, critical ones first", () => {
    const md = renderMarkdown(
      run([task("plain", [false], ["rate-ceiling"]), task("flaky-one", [true, false], ["verify-before-book"]), task("key", [false], ["eligible-carrier", "rate-ceiling"], { critical: true }), task("fine", [true]), task("down", ["skipped"])]),
    );
    const rows = section(md, "Failed tasks").filter((l) => l.startsWith("| ") && !l.startsWith("| Task")).map(cells);
    expect(rows).toEqual([
      ["`key` (critical)", "0/1", "`eligible-carrier`, `rate-ceiling`"],
      ["`plain`", "0/1", "`rate-ceiling`"],
      ["`flaky-one`", "1/2 flaky", "`verify-before-book`"],
    ]);
  });

  it("shortens a long list of a task's failed checks", () => {
    const md = renderMarkdown(run([task("t", [false], ["a", "b", "c", "d", "e", "f", "g"])]));
    expect(cells(section(md, "Failed tasks").at(-1)!)[2]).toBe("`a`, `b`, `c`, `d`, `e` and 2 more");
  });

  it("lists the top failure modes, at most eight", () => {
    const modes = Array.from({ length: 10 }, (_, i) => ({ id: `rule-${i}`, kind: "invariant" as const, count: 10 - i, tasks: ["a", "b"], example: "Booked it anyway." }));
    const rows = section(renderMarkdown(run([task("t", [false])], { failureModes: modes })), "Top failure modes").filter((l) => l.startsWith("| ") && !l.startsWith("| Count")).map(cells);
    expect(rows).toHaveLength(8);
    expect(rows[0]).toEqual(["10×", "invariant `rule-0`", "2", "Booked it anyway."]);
  });

  it("gives the soft rules' rates, apart, and says they never fail a trial", () => {
    const soft = [
      { id: "counter-at-ceiling", description: "d", tool: "log_offer", applied: 8, broken: 3, rate: 0.375, tasks: ["t"] },
      { id: "no-jargon", description: "d", applied: 4, broken: 0, rate: 0, tasks: [] },
      { id: "never-ran", description: "d", tool: "submit_offer", applied: 0, broken: 0, rate: null, tasks: [] },
    ];
    const got = section(renderMarkdown(run([task("t", [true])], { soft })), "Soft rules");
    expect(got[0]).toBe("Reported, never fail a trial.");
    expect(got.filter((l) => l.startsWith("| ") && !l.startsWith("| Rule")).map(cells)).toEqual([
      ["`counter-at-ceiling`", "37.5%", "3 of 8 trials that called `log_offer`"],
      ["`no-jargon`", "0.0%", "0 of 4 trials"],
      ["`never-ran`", "no rate", "no trial called `submit_offer`"],
    ]);
  });

  it("ends with the version that wrote the run, and the one that regraded it", () => {
    const footer = (over: Partial<SuiteResult>) => lines(renderMarkdown(run([task("t", [true])], over)).trimEnd()).at(-1);
    expect(footer({})).toBe("Written by [sandtable-ai](https://github.com/sandtable-ai/sandtable) 1.4.0.");
    expect(footer({ sandtable: { version: "1.4.0", regradedWith: "1.5.0" } })).toBe("Written by [sandtable-ai](https://github.com/sandtable-ai/sandtable) 1.4.0, regraded with 1.5.0.");
    expect(footer({ sandtable: {} })).toBe("Written by [sandtable-ai](https://github.com/sandtable-ai/sandtable).");
  });

  it("reads results from before verdicts and soft rules", () => {
    const { graded: _g, verdict: _v, ...old } = task("t", [true, false]);
    const { soft: _s, sandtable: _t, ...stored } = run([old as SuiteResult["tasks"][number]]);
    const md = renderMarkdown(stored as SuiteResult);
    expect(cells(section(md, "Failed tasks").at(-1)!)[1]).toBe("1/2 flaky");
  });
});

describe("the judged score in the summary", () => {
  const verdict = (id: string, v: JudgedVerdict["verdict"], more: Partial<JudgedVerdict> = {}): JudgedVerdict => ({ id, criterion: `The agent does ${id}.`, verdict: v, reason: `${id} because.`, ...more });
  function judged(verdicts: JudgedVerdict[], pending: string[] = [], over: Partial<SuiteResult> = {}): SuiteResult {
    const r = run([task("a", [true]), task("b", [true])], over);
    const criteria = verdicts.map((v) => ({ id: v.id, criterion: v.criterion, ...(pending.includes(v.id) ? { pending: true as const } : {}) }));
    r.tasks[0]!.trials[0]!.judged = { model: "claude-sonnet-5-5", verdicts };
    return withJudgedSummary(r, () => criteria);
  }

  it("is in its own lines, labelled as a model's judgement and apart from pass^k", () => {
    const md = renderMarkdown(judged([verdict("reads-back", "pass"), verdict("polite", "fail"), verdict("callback", "not_applicable")]));
    const got = section(md, "Judged score");
    expect(got[0]).toBe("A model's judgement, apart from pass^k: it never changes pass/fail, pass^k, a gate or an exit code.");
    expect(got).toContain("**judged** 50.0%: 1 pass, 1 fail, 1 not applicable, 3 not judged, by `claude-sonnet-5-5`");
    expect(got.filter((l) => l.startsWith("| ") && !l.startsWith("| Criterion")).map(cells)).toEqual([
      ["`reads-back`", "100.0%", "1 pass, 0 fail"],
      ["`polite`", "0.0%", "0 pass, 1 fail"],
      ["`callback`", "n/a", "0 pass, 0 fail, 1 not applicable"],
    ]);
    // pass^k's line says nothing of it.
    expect(lines(md).find((l) => l.startsWith("- **pass^1**"))).not.toContain("judged");
  });

  it("says when the score rests on a criterion pending review, and when a judge call failed", () => {
    const r = judged([verdict("polite", "fail"), verdict("draft", "pass")], ["draft"]);
    r.tasks[1]!.trials[0]!.judged = { model: "claude-sonnet-5-5", verdicts: [], error: "overloaded" };
    const got = section(renderMarkdown(r), "Judged score");
    expect(got).toContain("This score rests on 1 criterion still pending review: `draft`");
    expect(got).toContain("1 trial's judge call failed, so it isn't in the score.");
    expect(cells(got.find((l) => l.includes("`draft`") && l.startsWith("| "))!)[0]).toBe("`draft` (pending review)");
  });

  it("lists each failed verdict with its reason and quote, behind a toggle, and marks a quote that isn't in the transcript", () => {
    const md = renderMarkdown(judged([verdict("kept", "pass"), verdict("found", "fail", { quote: "No way." }), verdict("made-up", "fail", { quote: "I never said this.", quoteFound: false })]));
    const got = section(md, "Judged score");
    expect(got).toContain("<details>");
    expect(got).toContain("<summary>2 failed verdicts</summary>");
    expect(got).toContain("- `a` trial 1, `found`: found because. “No way.”");
    expect(got).toContain("- `a` trial 1, `made-up`: made-up because. “I never said this.” (this quote isn't in the transcript)");
    expect(got.join("\n")).not.toContain("kept because");
  });

  it("escapes the verdict's text, which comes from a model and a transcript", () => {
    const bad = (what: string) => `<img src=x onerror=${what}> | **bold** [x](https://bad.example) @someone #12\nnext`;
    const md = renderMarkdown(judged([{ id: bad("id"), criterion: bad("criterion"), verdict: "fail", quote: bad("quote"), reason: bad("reason") }], [], {}));
    expect(md).not.toContain("<img");
    expect(md).not.toContain("**bold**");
    expect(md).not.toContain("](https://bad");
    expect(md).not.toMatch(/(?<!\\)@someone/);
    expect(md).not.toMatch(/(?<!\\)#12/);
    expect(md).toContain("&lt;img src=x onerror=reason&gt;");
    expect(md).toContain("&lt;img src=x onerror=quote&gt;");
    expect(md).not.toMatch(/\nnext/);
  });

  it("escapes the judge's model name", () => {
    const r = judged([verdict("a", "pass")]);
    r.judged!.models = ["<b>m</b>|x"];
    expect(section(renderMarkdown(r), "Judged score").join("\n")).toContain("&lt;b&gt;m&lt;/b&gt;\\|x");
  });

  it("shows how the score moved since a baseline, in its own section, as no regression", () => {
    const before = judged([verdict("kept", "pass"), verdict("reworded", "pass"), verdict("gone", "fail")], [], { runId: "run-base" });
    const now = judged([verdict("kept", "fail"), verdict("reworded", "pass", { criterion: "Now reworded." }), verdict("fresh", "not_applicable")]);
    const md = renderMarkdown({ ...now, baseline: baselineSnapshot(before) });
    const got = section(md, "Judged score since the baseline");
    expect(got[0]).toBe("A model's judgement: never a regression, and it changes no gate or exit code.");
    expect(got.filter((l) => l.startsWith("| ") && !l.startsWith("| Criterion")).map(cells)).toEqual([
      ["**judged**", "66.7%", "50.0%", "−16.7 pts", ""],
      ["`kept`", "100.0%", "0.0%", "−100.0 pts", ""],
      ["`reworded`", "100.0%", "100.0%", "no change", "text differs"],
      ["`fresh`", "–", "n/a", "", "only in this run"],
      ["`gone`", "0.0%", "–", "", "only in the baseline"],
    ]);
    expect(got.join("\n")).toContain("a date from `${today}` under `clock: now` differs from day to day");
    expect(section(md, "Changes since the baseline").join("\n")).not.toContain("kept");
  });

  it("has no judged sections for a run that was never judged, and a baseline that wasn't either", () => {
    const plain = run([task("t", [true])]);
    expect(renderMarkdown({ ...plain, baseline: baselineSnapshot(plain) })).not.toMatch(/judg/i);
  });
});

describe("what a run holds, in a table or a line", () => {
  const nasty = "a|b*c_d`e<img src=x>[l](u)&amp;";
  const shown = "a\\|b\\*c\\_d\\`e&lt;img src=x&gt;\\[l\\]\\(u\\)&amp;amp;";

  it("escapes a task id and a check id, so they can't break a table or inject HTML", () => {
    const md = renderMarkdown(run([task(nasty, [false], [nasty])]));
    const row = section(md, "Failed tasks").at(-1)!;
    expect(cells(row)).toEqual([shown, "0/1", shown]);
    expect(md).not.toContain("<img");
  });

  it("escapes a failure mode's id, kind and example", () => {
    const md = renderMarkdown(run([task("t", [false])], { failureModes: [{ id: nasty, kind: "invariant", count: 1, tasks: ["t"], example: `${nasty}\nsecond line` }] }));
    const row = section(md, "Top failure modes").at(-1)!;
    expect(cells(row)).toEqual(["1×", `invariant ${shown}`, "1", `${shown} second line`]);
  });

  it("escapes a soft rule's id and its tool", () => {
    const soft = [{ id: nasty, description: "d", tool: nasty, applied: 2, broken: 1, rate: 0.5, tasks: [] }];
    expect(cells(section(renderMarkdown(run([task("t", [true])], { soft })), "Soft rules").at(-1)!)).toEqual([shown, "50.0%", `1 of 2 trials that called ${shown}`]);
  });

  it("escapes the domain, the agent, the user and a floor's tag", () => {
    const md = renderMarkdown(run([task("t", [true])], { domain: nasty, agent: nasty, user: nasty, floors: { [nasty]: 1 }, byTag: [{ tag: nasty, tasks: 1, passHat1: 1, passHatK: 1 }] }));
    expect(lines(md)[0]).toBe(`### sandtable · ${shown} · agent ${shown} · user ${shown} · k=1`);
    expect(lines(md).join("\n")).toContain(`- **Floor** ${shown} 100.0%`);
    expect(md).not.toContain("<img");
  });

  it("escapes a task id in the changes since a baseline, and the baseline's run id", () => {
    const before = run([task(nasty, [true])], { runId: nasty });
    const now = run([task(nasty, [false])]);
    const got = section(renderMarkdown({ ...now, baseline: baselineSnapshot(before) }), "Changes since the baseline");
    expect(got[0]).toBe(`Compared with run ${shown}, started 2026-10-21T00:00:00.000Z.`);
    expect(cells(got.find((l) => l.startsWith("| broken"))!)).toEqual(["broken", shown, "1/1", "0/1"]);
  });

  it("keeps text from a transcript from mentioning anyone, linking an issue or a site, or setting math", () => {
    const said = "Ask @someone about #12, see https://bad.example or www.bad.example, it costs $2100 or $1450.";
    const md = renderMarkdown(run([task("t", [false])], { failureModes: [{ id: "x", kind: "invariant", count: 1, tasks: ["t"], example: said }] }));
    const example = cells(section(md, "Top failure modes").at(-1)!)[3]!;
    expect(example).toBe("Ask \\@someone about \\#12, see https\\://bad.example or www\\.bad.example, it costs \\$2100 or \\$1450.");
  });

  it("writes an ordinary id as code, which needs no escaping", () => {
    const md = renderMarkdown(run([task("book_load-v2.1", [false], ["state:bookings#1"])]));
    expect(cells(section(md, "Failed tasks").at(-1)!)).toEqual(["`book_load-v2.1`", "0/1", "`state:bookings#1`"]);
  });
});

describe("a long run", () => {
  const failing = (n: number, id = (i: number) => `task-${i}`) => run(Array.from({ length: n }, (_, i) => task(id(i), [false], ["verify-before-book", "rate-ceiling"])));
  const more = (md: string) => Number(/and (\d+) more; see report\.html/.exec(md)?.[1]);

  it("puts a long list behind a toggle, and a short one in the open", () => {
    const short = renderMarkdown(failing(10));
    expect(short).not.toContain("<details>");
    const long = section(renderMarkdown(failing(11)), "Failed tasks");
    expect(long[0]).toBe("<details>");
    expect(long[1]).toBe("<summary>11 failed tasks</summary>");
    expect(long.at(-1)).toBe("</details>");
  });

  it("lists the first failed tasks past the cap and says how many more, under GitHub's limit, for 500 tasks", () => {
    const md = renderMarkdown(failing(500));
    expect(md.length).toBeLessThan(COMMENT_LIMIT);
    const rows = section(md, "Failed tasks").filter((l) => l.startsWith("| `task-"));
    expect(rows[0]).toContain("`task-0`");
    expect(rows.length + more(md)).toBe(500);
    expect(more(md)).toBeGreaterThan(0);
  });

  it("stays under the limit however long the ids and the text are, in every section", () => {
    const long = (s: string, i: number) => `${s}-${i}-${"|<*".repeat(3000)}`;
    const tasks = Array.from({ length: 500 }, (_, i) => task(long("task", i), [false, true], Array.from({ length: 20 }, (_, c) => long("check", c))));
    const soft = Array.from({ length: 500 }, (_, i) => ({ id: long("soft", i), description: "d", tool: long("tool", i), applied: 2, broken: 1, rate: 0.5, tasks: [] }));
    const failureModes = Array.from({ length: 500 }, (_, i) => ({ id: long("mode", i), kind: "invariant" as const, count: 1, tasks: ["t"], example: long("example", i) }));
    const r = run(tasks, { soft, failureModes, domain: long("domain", 0), agent: long("agent", 0), user: long("user", 0) });
    const verdicts = Array.from({ length: 200 }, (_, i): JudgedVerdict => ({ id: long("criterion", i), criterion: long("text", i), verdict: "fail", quote: long("quote", i), reason: long("reason", i) }));
    for (const t of r.tasks) t.trials[0]!.judged = { model: long("model", 0), verdicts };
    const criteria = verdicts.map((v) => ({ id: v.id, criterion: v.criterion }));
    const scored = withJudgedSummary(r, () => criteria);
    const md = renderMarkdown({ ...scored, baseline: baselineSnapshot(run(Array.from({ length: 500 }, (_, i) => task(long("task", i), [true, true])), { runId: long("run", 0), agent: long("other", 0), judged: scored.judged })) });
    expect(md.length).toBeLessThan(COMMENT_LIMIT);
    expect(md).toContain("see report.html");
    expect(md).toContain("Written by [sandtable-ai]");
    expect(md).toContain("### Judged score");
    expect(md).not.toContain("<*");
  });

  it("caps the changes since a baseline too, with what moved in the toggle's summary", () => {
    const before = run(Array.from({ length: 300 }, (_, i) => task(`task-${i}`, [true])));
    const now = run(Array.from({ length: 300 }, (_, i) => task(`task-${i}`, [i % 2 === 0 ? false : true])));
    const md = renderMarkdown({ ...now, baseline: baselineSnapshot(before) });
    const got = section(md, "Changes since the baseline");
    expect(got).toContain("<summary>150 tasks moved: 150 broken</summary>");
    expect(got.join("\n")).toMatch(/and \d+ more; see report\.html/);
    expect(md.length).toBeLessThan(COMMENT_LIMIT);
  });
});

describe.skipIf(!process.features.typescript)("report --markdown", () => {
  // No key and nothing listening: nothing here may call a model.
  const env = { ...process.env, ANTHROPIC_API_KEY: "", ANTHROPIC_BASE_URL: "http://127.0.0.1:9" };
  const sandtable = (...args: string[]) =>
    promisify(execFile)(process.execPath, [cli, ...args], { env }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (e: { code: number; stdout: string; stderr: string }) => e,
    );
  const tmp = () => mkdtempSync(path.join(tmpdir(), "sandtable-markdown-"));
  let dir: string;
  let results: string;
  let expected: string;

  beforeAll(async () => {
    dir = tmp();
    await sandtable("run", example, "--agent", "scripted:naive", "--user", "scripted", "-t", "book-at-posted-rate,no-mc-number", "--no-html", "-o", dir);
    results = path.join(dir, "results.json");
    expected = renderMarkdown(JSON.parse(readFileSync(results, "utf8")) as SuiteResult);
  });

  it("--markdown - prints the summary and nothing else, and writes no report", async () => {
    const r = await sandtable("report", results, "--markdown", "-");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe(expected);
    expect(r.stderr).toBe("");
    expect(existsSync(path.join(dir, "report.html"))).toBe(false);
    expect(lines(r.stdout)[0]).toContain("`freight-carrier-sales`");
    expect(r.stdout).toContain("`book-at-posted-rate`");
  });

  it("--markdown <file> writes the summary there, creating its folder, and prints the path", async () => {
    const file = path.join(tmp(), "new", "summary.md");
    const r = await sandtable("report", results, "--markdown", file);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(file);
    expect(readFileSync(file, "utf8")).toBe(expected);
    expect(existsSync(path.join(dir, "report.html"))).toBe(false);
  });

  it("with -o too, writes the report as well, and keeps stdout to the summary under -", async () => {
    const out = path.join(tmp(), "html");
    const r = await sandtable("report", results, "-o", out, "--markdown", "-");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe(expected);
    expect(r.stderr.trim()).toBe(path.join(out, "report.html"));
    expect(existsSync(path.join(out, "report.html"))).toBe(true);
    const file = path.join(tmp(), "summary.md");
    const both = await sandtable("report", results, "-o", out, "--markdown", file);
    expect(lines(both.stdout.trim())).toEqual([file, path.join(out, "report.html")]);
  });

  it("without --markdown, behaves as it does today", async () => {
    const copy = tmp();
    writeFileSync(path.join(copy, "results.json"), readFileSync(results));
    const r = await sandtable("report", path.join(copy, "results.json"));
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(path.join(copy, "report.html"));
    expect(existsSync(path.join(copy, "report.html"))).toBe(true);
  });

  it("renders the changes for a run with a baseline, from run --baseline and from compare -o", async () => {
    const careful = tmp();
    await sandtable("run", example, "--agent", "scripted:careful", "--user", "scripted", "-t", "book-at-posted-rate,no-mc-number", "--no-html", "-o", careful);
    const after = path.join(careful, "results.json");
    const compared = tmp();
    await sandtable("compare", results, after, "--no-html", "-o", compared);
    const fromCompare = await sandtable("report", path.join(compared, "results.json"), "--markdown", "-");
    expect(fromCompare.stdout).toContain("### Changes since the baseline");
    expect(fromCompare.stdout).toMatch(/\| fixed \| `book-at-posted-rate` \| 0\/1 \| 1\/1 \|/);

    const rerun = tmp();
    await sandtable("run", example, "--agent", "scripted:careful", "--user", "scripted", "-t", "book-at-posted-rate,no-mc-number", "--no-html", "-o", rerun, "--baseline", results);
    const fromRun = await sandtable("report", path.join(rerun, "results.json"), "--markdown", "-");
    expect(fromRun.stdout).toMatch(/\| fixed \| `book-at-posted-rate` \| 0\/1 \| 1\/1 \|/);
  });

  it("refuses --audience customer, which has its own page, with exit 2", async () => {
    const r = await sandtable("report", results, "--audience", "customer", "--markdown", "-");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--markdown is a summary for engineers");
    expect(r.stdout).toBe("");
  });

  it("names --markdown and the path when it can't write there", async () => {
    const file = path.join(tmp(), "afile");
    writeFileSync(file, "");
    const under = await sandtable("report", results, "--markdown", path.join(file, "summary.md"));
    expect(under.code).toBe(2);
    expect(under.stderr.trim()).toBe(`--markdown: ${file} is a file, not a folder. Pass a path for the summary, or - for stdout.`);
    const folder = tmp();
    mkdirSync(path.join(folder, "a-folder"));
    const isFolder = await sandtable("report", results, "--markdown", path.join(folder, "a-folder"));
    expect(isFolder.code).toBe(2);
    expect(isFolder.stderr.trim()).toBe(`--markdown: ${path.join(folder, "a-folder")} is a folder, not a file. Pass a path for the summary, or - for stdout.`);
  });

  it("a missing or wrong results file says so, as report does, and prints no summary", async () => {
    const r = await sandtable("report", path.join(tmp(), "nope.json"), "--markdown", "-");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("report: no file at");
    expect(r.stdout).toBe("");
  });

  it("renders a real run in-process the same way, with no model", async () => {
    const domain = await loadDomain(example);
    const r = await runSuite({ domain, agent: freightScriptedAgent("naive"), user: scriptedUser(), taskIds: ["book-at-posted-rate"] });
    const md = renderMarkdown(r);
    expect(section(md, "Failed tasks").join("\n")).toContain("`book-at-posted-rate`");
    expect(section(md, "Top failure modes").join("\n")).toContain("`verify-before-book`");
  });
});
