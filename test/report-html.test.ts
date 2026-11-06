import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { freightScriptedAgent } from "../src/demo/freight-agents.ts";
import { withJudgedSummary, type JudgedVerdict, type TrialJudgement } from "../src/judge/summary.ts";
import { MARK_SVG } from "../src/report/brand.ts";
import { renderHtml } from "../src/report/html.ts";
import { baselineSnapshot } from "../src/run/compare.ts";
import { runSuite, type SuiteResult } from "../src/run/suite.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import { loadDomain } from "../src/spec/load.ts";

/** Run the report's script against a stand-in for the page, and return what each element shows; `open` opens a trial first. */
function page(html: string, open?: [task: number, trial: number]): Map<string, string> {
  const script = html.slice(html.indexOf("<script>") + "<script>".length, html.indexOf("</script>"));
  const elements = new Map<string, { innerHTML: string; textContent: string; scrollIntoView(): void }>();
  const document = {
    getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, { innerHTML: "", textContent: "", scrollIntoView() {} });
      return elements.get(id)!;
    },
  };
  vm.runInContext(`${script}${open ? `\nshow(${open[0]}, ${open[1]});` : ""}`, vm.createContext({ document }));
  return new Map([...elements].map(([id, e]) => [id, e.innerHTML || e.textContent]));
}

/** Open one trial, and return what it shows. */
const openTrial = (html: string, task: number, trial: number) => page(html, [task, trial]).get("detail")!;

describe("HTML report world changes", () => {
  it("shows an update as the fields it changed, with the whole row behind a toggle, and an insert as its row", async () => {
    const r = await runSuite({ domain: await loadDomain(path.resolve("examples/freight")), agent: freightScriptedAgent("careful"), user: scriptedUser(), taskIds: ["book-at-posted-rate"] });
    const trial = r.tasks[0]!.trials[0]!;
    expect(trial.changes.map((c) => c.kind).sort()).toEqual(["insert", "update"]);
    const lines = openTrial(renderHtml(r), 0, 0).split('<div class="change">').slice(1);
    const update = lines.find((l) => l.startsWith("update loads L-1001"))!;
    // Only the field that changed is shown before the toggle; the rest of the row is behind it.
    const [shown, hidden] = update.split("<details>");
    expect(shown).toBe("update loads L-1001 <b>status</b> &quot;available&quot; → &quot;booked&quot;");
    expect(hidden).toContain("<summary>whole row</summary>");
    expect(hidden).toContain("&quot;origin&quot;: &quot;Dallas, TX&quot;");
    const insert = lines.find((l) => l.startsWith("insert bookings"))!;
    expect(insert).not.toContain("<details>");
    expect(insert).toContain("&quot;load_id&quot;: &quot;L-1001&quot;");
  });

  it("marks a field an update added or removed as unset on the other side", () => {
    const r = {
      domain: "d", agent: "a", user: "u", k: 1, startedAt: "", durationMs: 0, passHat: { "1": 1 }, failureModes: [], byTag: [], soft: [], pendingReview: [],
      usage: { agent: {}, user: {}, costUsd: null }, latency: { agentTurnP50Ms: null, agentTurnP95Ms: null }, inputs: "x", runId: "r", version: 1,
      tasks: [{ id: "t", description: "", tags: [], passes: 1, trials: [{ taskId: "t", trial: 0, passed: true, endReason: "user_stop", turns: 1, durationMs: 0, checks: [], violations: [], events: [],
        changes: [{ table: "loads", key: "L-1", kind: "update", before: { status: "open", note: "x" }, after: { status: "open", hold: true } }] }] }],
    };
    const html = openTrial(renderHtml(r as never), 0, 0);
    expect(html).toContain("<b>note</b> &quot;x&quot; → (unset), <b>hold</b> (unset) → true<details>");
  });
});

describe("HTML report page", () => {
  it("is one self-contained file: the logo is inline and nothing is fetched, fonts included", async () => {
    const r = await runSuite({ domain: await loadDomain(path.resolve("examples/freight")), agent: freightScriptedAgent("careful"), user: scriptedUser(), taskIds: ["book-at-posted-rate"] });
    const html = renderHtml(r);
    expect(html).toContain(`<div class="head">${MARK_SVG}<h1>`);
    expect(html).not.toMatch(/@import|@font-face|url\(|<link|\ssrc=/);
  });
});

describe("the judged score in the HTML report", () => {
  const verdict = (id: string, v: JudgedVerdict["verdict"], more: Partial<JudgedVerdict> = {}): JudgedVerdict => ({ id, criterion: `The agent does ${id}.`, verdict: v, reason: `${id} because.`, ...more });

  /** Two tasks' trials, the first with this judgement and the second with none, counted as `judge` counts them. */
  async function judgedRun(judgement: Omit<TrialJudgement, "model"> & { model?: string }, pending: string[] = []): Promise<SuiteResult> {
    const r = await runSuite({ domain: await loadDomain(path.resolve("examples/freight")), agent: freightScriptedAgent("careful"), user: scriptedUser(), taskIds: ["book-at-posted-rate", "no-mc-number"] });
    const criteria = judgement.verdicts.map((v) => ({ id: v.id, criterion: v.criterion, ...(pending.includes(v.id) ? { pending: true as const } : {}) }));
    r.tasks[0]!.trials[0]!.judged = { model: "claude-sonnet-5-5", ...judgement };
    return withJudgedSummary(r, () => criteria, { "claude-sonnet-5-5": { calls: 1, input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 } });
  }

  it("has a section after the soft rules, labelled as a model's judgement: the score, the model, the counts and a row per criterion", async () => {
    const r = await judgedRun({ verdicts: [verdict("reads-back", "pass"), verdict("polite", "fail"), verdict("callback", "not_applicable")] }, ["polite"]);
    const html = renderHtml(r);
    expect(html.indexOf('<div id="soft">')).toBeLessThan(html.indexOf('<div id="judged">'));
    expect(html.indexOf('<div id="judged">')).toBeLessThan(html.indexOf('<div id="coverage">'));
    const section = page(html).get("judged")!;
    expect(section).toContain("<h2>Judged score</h2>");
    expect(section).toContain("A model's judgement");
    expect(section).toContain("never changes pass/fail or pass^k");
    expect(section).toContain("<b>50.0%</b><span>judged score</span>");
    expect(section).toContain("<b>3</b><span>not judged</span>");
    expect(section).toContain("<b>1</b><span>pending review</span>");
    expect(section).toContain("claude-sonnet-5-5");
    expect(section.split("<tbody>")[1]!.split("<tr>").slice(1).map((row) => row.match(/<code>([^<]+)<\/code>/)![1])).toEqual(["reads-back", "polite", "callback"]);
    expect(section).toContain("The agent does reads-back.");
    expect(section).toContain('<span class="chip">pending review</span>');
    // It stays out of the headline numbers, which keep saying what grading decided.
    expect(page(html).get("kpis")).not.toContain("judged");
    expect(page(html).get("kpis")).toContain("pass^1");
  });

  it("links each criterion to the trials that failed it", async () => {
    const section = page(renderHtml(await judgedRun({ verdicts: [verdict("polite", "fail")] }))).get("judged")!;
    expect(section).toContain("show(0,0);return false");
    expect(section).toContain("book-at-posted-rate trial 1");
  });

  it("shows each verdict in a trial's detail, with its criterion, quote and reason, and marks a quote that isn't in the transcript", async () => {
    const r = await judgedRun({ verdicts: [verdict("found", "pass", { quote: "Booked L-1001" }), verdict("made-up", "fail", { quote: "I never said this", quoteFound: false }), verdict("not-asked", "not_applicable")] });
    const detail = openTrial(renderHtml(r), 0, 0);
    const judged = detail.split("<h2>Judged</h2>")[1]!.split("<h2>World changes</h2>")[0]!;
    expect(judged).toContain("never change this trial's result");
    const rows = judged.split('<div class="check">').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("<code>found</code>");
    expect(rows[0]).toContain("The agent does found.");
    expect(rows[0]).toContain("“Booked L-1001”");
    expect(rows[0]).toContain("found because.");
    expect(rows[0]).not.toContain("not in the transcript");
    expect(rows[1]).toContain("“I never said this”");
    expect(rows[1]).toContain("not in the transcript");
    expect(rows[2]).toContain("not applicable");
    // The second trial has no judgement, so its detail has no such part.
    expect(openTrial(renderHtml(r), 1, 0)).not.toContain("Judged");
  });

  it("says when a trial's judge call failed, and counts it", async () => {
    const html = renderHtml(await judgedRun({ verdicts: [verdict("kept", "pass")], error: "overloaded" }));
    const detail = openTrial(html, 0, 0);
    expect(detail).toContain("The judge call for this trial failed: overloaded");
    expect(detail).toContain("<code>kept</code>");
    expect(page(html).get("judged")).toContain("1 judge call failed");
  });

  it("escapes the verdict, the quote, the reason and everything else that came from a model or a transcript", async () => {
    const bad = (what: string) => `<img src=x onerror=alert('${what}')>"</script>`;
    const r = await judgedRun({
      model: bad("model"),
      error: bad("error"),
      verdicts: [
        { id: bad("id"), criterion: bad("criterion"), verdict: bad("verdict") as JudgedVerdict["verdict"], quote: bad("quote"), quoteFound: false, reason: bad("reason") },
        { id: "other", criterion: "Other.", verdict: "fail", quote: bad("quote2"), reason: bad("reason2") },
      ],
    });
    const html = renderHtml(r);
    const shown = page(html, [0, 0]);
    for (const part of [shown.get("judged")!, shown.get("detail")!.split("<h2>Judged</h2>")[1]!.split("<h2>World changes</h2>")[0]!]) {
      expect(part).not.toContain("<img");
      expect(part).not.toContain("</script>");
      expect(part).toContain("&lt;img src=x");
      expect(part).toContain("&quot;&lt;/script&gt;");
    }
    expect(shown.get("detail")).toContain("alert('quote')");
    expect(shown.get("detail")).toContain("alert('reason')");
    expect(shown.get("detail")).toContain("alert('verdict')");
    // Nor does any of it close the script the run is embedded in.
    expect(html.indexOf("</script>")).toBe(html.lastIndexOf("</script>"));
    expect(html).not.toContain("<img");
  });

  it("shows how the score changed since a baseline, apart from the task changes, escaped, and never as a regression", async () => {
    const before = await judgedRun({ verdicts: [verdict("kept", "pass"), verdict("reworded", "pass"), verdict("<b>gone</b>", "fail")] });
    const after = await judgedRun({ verdicts: [verdict("kept", "fail"), verdict("reworded", "pass", { criterion: "Now reworded." })] });
    const shown = page(renderHtml({ ...after, baseline: baselineSnapshot(before) }));
    const since = shown.get("judged")!.split("<h2>Judged score since the baseline</h2>")[1]!;
    expect(since).toContain("A model's judgement: never a regression");
    expect(since).toContain("<td>66.7%</td><td>50.0%</td><td>−16.7 pts</td>");
    expect(since).toContain("<code>kept</code></td><td>100.0%</td><td>0.0%</td><td>−100.0 pts</td>");
    expect(since).toContain("text differs");
    expect(since).toContain("only in the baseline");
    expect(since).toContain("&lt;b&gt;gone&lt;/b&gt;");
    expect(since).not.toContain("<b>gone");
    expect(since).not.toContain("badt");
    expect(shown.get("baseline")).not.toContain("Judged");
    // A task whose judged score fell isn't marked regressed.
    expect(shown.get("tasks")).not.toContain("since baseline");
  });

  it("renders a run with no judged score as before: nothing about it anywhere on the page", async () => {
    const r = await runSuite({ domain: await loadDomain(path.resolve("examples/freight")), agent: freightScriptedAgent("careful"), user: scriptedUser(), taskIds: ["book-at-posted-rate"] });
    const shown = page(renderHtml({ ...r, baseline: baselineSnapshot(r) }), [0, 0]);
    expect(shown.get("judged") ?? "").toBe("");
    for (const [id, html] of shown) expect(html, id).not.toMatch(/judged/i);
  });
});
