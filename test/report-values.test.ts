import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { renderCustomerHtml } from "../src/report/customer.ts";
import { renderHtml } from "../src/report/html.ts";
import { renderMarkdown } from "../src/report/markdown.ts";
import { renderLeaderboardHtml, type LeaderboardResult } from "../src/run/leaderboard.ts";
import type { SuiteResult } from "../src/run/suite.ts";

// results.json is a contract that hand-made and older files keep being read under, so any field in one can hold any
// type. These tests put a marker in one place of a run at a time and check that every report shows it as text. One at
// a time, so that a value that stops a report early can't hide a later place that prints another.

const TAG = "<b id=mark>";
const SHOWN_AS_TAG = "<b id=mark";
const SHOWN_AS_TEXT = "&lt;b id=mark";

const tokens = { calls: 2, input: 10, output: 5, cacheRead: 1, cacheWrite: 1, maxTokensStops: 1, reasoningStripped: 1, emptyAfterStrip: 1 };
const usage = () => ({ agent: { "model-a": { ...tokens } }, user: { "model-b": { ...tokens } }, costUsd: 1.25 });

const failedTrial = () => ({
  taskId: "book-load",
  trial: 0,
  passed: false,
  checks: [
    { id: "rate-ceiling", kind: "invariant", passed: false, detail: "Booked over the ceiling" },
    { id: "load-booked", kind: "state", passed: true, detail: "The load is booked" },
  ],
  violations: [{ invariant: "rate-ceiling", description: "Stay under the ceiling", tool: "book_load", detail: "Booked over the ceiling" }],
  soft: [
    { id: "use-name", broken: true, violations: [{ invariant: "use-name", description: "Use the caller's name", detail: "Never used it" }] },
    { id: "say-thanks", broken: false, violations: [] },
  ],
  callerNotes: [{ turn: 1, text: "My instructions say to ask", why: "talks about its instructions" }],
  attribution: { owner: "agent-policy", evidence: "The agent broke rate-ceiling" },
  judged: {
    model: "judge-a",
    error: "The judge call timed out",
    verdicts: [
      { id: "tone", criterion: "The tone stays kind", verdict: "fail", quote: "Take it or leave it", quoteFound: false, reason: "It pushed the caller" },
      { id: "clarity", criterion: "The rate is clear", verdict: "not_applicable", reason: "No rate came up" },
    ],
  },
  events: [
    { type: "user", text: "I can haul that load" },
    { type: "agent", text: "What is your rate?", latencyMs: 40 },
    {
      type: "tool",
      index: 3,
      name: "book_load",
      args: { load_id: "L-1", rate: 900 },
      ok: false,
      error: "The server is busy",
      violations: ["rate-ceiling"],
      soft: ["use-name"],
      fault: { error: "rate_limit", status: 429, retryAfter: 2, latencyMs: 1500, committed: true },
      eventChanges: [{ table: "loads", key: "L-2", kind: "update", before: { status: "open" }, after: { status: "held" } }],
      via: "rest",
    },
    { type: "tool", index: 4, name: "get_load", args: { load_id: "L-1" }, ok: true, result: { status: "booked" }, violations: [] },
  ],
  changes: [
    { table: "loads", key: "L-1", kind: "update", before: { status: "open", rate: 800 }, after: { status: "booked", rate: 900 } },
    { table: "calls", key: "C-1", kind: "insert", after: { outcome: "booked" } },
    { table: "calls", key: "C-0", kind: "delete", before: { outcome: "stale" } },
  ],
  endReason: "user_stop",
  turns: 3,
  durationMs: 2500,
  usage: usage(),
});

const noUsage = { agent: {}, user: {}, costUsd: null };

const passedTrial = (taskId: string, trial: number) => ({
  taskId,
  trial,
  passed: true,
  checks: [{ id: "load-booked", kind: "state", passed: true, detail: "The load is booked" }],
  violations: [],
  soft: [],
  events: [],
  changes: [],
  endReason: "max_turns",
  turns: 1,
  durationMs: 40,
  usage: noUsage,
});

/** A passed trial with a judged verdict that passed. */
const judgedTrial = (taskId: string, trial: number) => ({
  ...passedTrial(taskId, trial),
  judged: { model: "judge-a", verdicts: [{ id: "tone", criterion: "The tone stays kind", verdict: "pass", reason: "It stayed kind" }] },
});

/** A failed trial with nothing else to show. */
const plainFailedTrial = (taskId: string, trial: number) => ({
  ...passedTrial(taskId, trial),
  passed: false,
  checks: [{ id: "rate-ceiling", kind: "invariant", passed: false, detail: "Booked over the ceiling" }],
  endReason: "user_stop",
});

const skippedTrial = (taskId: string, trial: number) => ({
  taskId,
  trial,
  passed: false,
  skipped: true,
  checks: [{ id: "run-error", kind: "error", passed: false, detail: "The model was unavailable" }],
  violations: [],
  soft: [],
  events: [],
  changes: [],
  endReason: "error",
  turns: 0,
  durationMs: 10,
  usage: noUsage,
  error: "The model was unavailable",
});

/** A run that reaches every section of every report: a failed critical task, a flaky one, skipped trials, and a baseline to compare with. */
const richRun = () =>
  ({
    version: 1,
    sandtable: { version: "1.4.0", regradedWith: "1.4.1" },
    runId: "run-now",
    domain: "sample-lanes",
    agent: "scripted:careful",
    withoutPolicy: true,
    user: "scripted",
    k: 2,
    inputs: "inputs-now",
    startedAt: "2026-11-06T09:00:00.000Z",
    durationMs: 5000,
    passHat: { "1": 0.5, "2": 0.25 },
    passAt: { "2": 0.75 },
    flipRate: 0.25,
    flaky: ["book-load"],
    skipped: 2,
    floors: { booking: 0.9, ops: 0.1 },
    pendingReview: [{ kind: "invariant", id: "draft-rule" }],
    usage: usage(),
    latency: { agentTurnP50Ms: 40, agentTurnP95Ms: 1500 },
    failureModes: [{ id: "rate-ceiling", kind: "invariant", count: 1, tasks: ["book-load"], example: "Booked over the ceiling" }],
    byTag: [
      { tag: "booking", tasks: 2, passHat1: 0.5, passHatK: 0.25 },
      { tag: "ops", tasks: 3, passHat1: 1, passHatK: 1 },
    ],
    soft: [
      { id: "use-name", description: "Use the caller's name", tool: "book_load", applied: 2, broken: 1, rate: 0.5, tasks: ["book-load"], example: "Never used it" },
      { id: "say-thanks", description: "Say thanks", applied: 0, broken: 0, rate: null, tasks: [] },
      { id: "quote-terms", description: "Quote the terms", tool: "get_terms", applied: 0, broken: 0, rate: null, tasks: [] },
    ],
    judged: {
      pass: 1,
      fail: 1,
      notApplicable: 1,
      score: 0.5,
      models: ["judge-a"],
      notJudged: 1,
      criteria: [
        { id: "tone", pass: 1, fail: 1, notApplicable: 0, score: 0.5, pending: true },
        { id: "clarity", pass: 0, fail: 0, notApplicable: 1, score: null },
      ],
      usage: { "judge-a": { ...tokens } },
      costUsd: 0.5,
    },
    coverage: {
      rules: [
        { id: "rate-ceiling", description: "Stay under the ceiling", kind: "limit", tool: "book_load", source: { file: "policy.md", quote: "**Never** go over the `ceiling`" }, checked: 2, broken: 1, tasks: [{ task: "book-load", planned: true, checked: 2, broken: 1 }, { task: "hold-line", planned: true, checked: 1, broken: 0 }, { task: "reach-desk", planned: true, checked: 0, broken: 0 }] },
        { id: "use-name", description: "Use the caller's name", kind: "require", tool: "book_load", soft: true, source: { file: "policy.md" }, checked: 2, broken: 1, tasks: [{ task: "book-load", planned: true, checked: 2, broken: 1 }] },
        { id: "keep-ceiling-private", description: "Keep the ceiling private", kind: "never_disclose", field: "max_rate", checked: 1, broken: 0, tasks: [{ task: "new-task", planned: false, checked: 1, broken: 0 }] },
        { id: "never-seen", description: "Log every call", kind: "require", tool: "log_call", checked: 0, broken: 0, tasks: [] },
      ],
      tools: [
        { name: "book_load", trials: 2, calls: 3, tasks: ["book-load"] },
        { name: "log_call", trials: 0, calls: 0, tasks: [] },
      ],
    },
    tasks: [
      { id: "book-load", description: "The caller books a load.", tags: ["booking"], critical: true, passes: 1, graded: 2, verdict: "flaky", interval: { low: 0.1, high: 0.9 }, inputs: "i1", grading: "g1", trials: [failedTrial(), judgedTrial("book-load", 1)] },
      { id: "hold-line", description: "The caller holds the line.", tags: ["ops"], passes: 1, graded: 1, verdict: "passed", interval: { low: 0.3, high: 1 }, inputs: "i2-new", grading: "g2-new", trials: [passedTrial("hold-line", 0)] },
      { id: "reach-desk", description: "The caller reaches the desk.", tags: ["ops"], passes: 0, graded: 1, skipped: 1, verdict: "failed", inputs: "i3", grading: "g3", trials: [plainFailedTrial("reach-desk", 0), skippedTrial("reach-desk", 1)] },
      { id: "all-skipped", description: "The caller is never reached.", tags: ["ops"], passes: 0, graded: 0, skipped: 1, verdict: "skipped", inputs: "i4", grading: "g4", trials: [skippedTrial("all-skipped", 0)] },
      { id: "new-task", description: "The caller asks for a new lane.", tags: ["ops"], passes: 1, graded: 1, verdict: "passed", inputs: "i5", grading: "g5", trials: [passedTrial("new-task", 0)] },
    ],
    baseline: {
      runId: "run-then",
      startedAt: "2026-10-06T09:00:00.000Z",
      agent: "scripted:naive",
      user: "scripted:old",
      k: 3,
      inputs: "inputs-then",
      passHat: { "1": 1 },
      tasks: [
        { id: "book-load", passes: 3, trials: 3, inputs: "i1", grading: "g1" },
        { id: "hold-line", passes: 3, trials: 3, inputs: "i2", grading: "g2" },
        { id: "reach-desk", passes: 2, trials: 3, inputs: "i3", grading: "g3" },
        { id: "all-skipped", passes: 1, trials: 3, inputs: "i4", grading: "g4" },
        { id: "gone-task", passes: 1, trials: 1, inputs: "i6", grading: "g6" },
      ],
      judged: {
        pass: 2,
        fail: 0,
        notApplicable: 0,
        score: 1,
        models: ["judge-b"],
        notJudged: 0,
        criteria: [
          { id: "tone", pass: 2, fail: 0, notApplicable: 0, score: 1, texts: ["The tone was kind"] },
          { id: "dropped", pass: 1, fail: 0, notApplicable: 0, score: 1, texts: ["A dropped criterion"] },
        ],
      },
    },
  }) as unknown as SuiteResult;

/** A careless agent's run of the same domain: it broke a hard rule and a soft one. */
const carelessRun = () =>
  ({
    ...richRun(),
    runId: "run-careless",
    agent: "scripted:naive (without policy)",
    baseline: undefined,
  }) as unknown as SuiteResult;

const richBoard = () =>
  ({
    version: 1,
    domain: "sample-lanes",
    user: "scripted",
    k: 2,
    taskSelection: { selected: 2, of: 5 },
    generatedAt: "2026-11-06T09:00:00.000Z",
    sandtable: { version: "1.4.0", commit: "abcdef0123", dirty: true },
    rows: [
      {
        label: "Model A",
        agent: "scripted:careful",
        effort: "high",
        baseline: false,
        passHat1: 1,
        passHatK: 0.5,
        tasks: 2,
        trials: 4,
        violations: { "rate-ceiling": 2, "use-name": 1 },
        topFailure: "rate-ceiling (2×)",
        soft: { "use-name": { applied: 2, broken: 1, rate: 0.5 }, "say-thanks": { applied: 0, broken: 0, rate: null } },
        critical: { tasks: 2, failed: ["book-load"] },
        costUsd: 1,
        costPerTrialUsd: 0.25,
        agentCostPerTrialUsd: 0.2,
        agentTurnP95Ms: 1500,
        agentTokens: 100,
      },
      { label: "Model B", agent: "scripted:naive", baseline: false, passHat1: 0, passHatK: 0, tasks: 2, trials: 4, violations: {}, soft: {}, costUsd: null, costPerTrialUsd: null, agentCostPerTrialUsd: 0.001, agentTurnP95Ms: null, agentTokens: 0, error: "The model was unavailable" },
      { label: "Do nothing", agent: "noop", baseline: true, passHat1: 0, passHatK: 0, tasks: 2, trials: 4, violations: {}, soft: {}, critical: { tasks: 2, failed: [] }, costUsd: null, costPerTrialUsd: null, agentCostPerTrialUsd: null, agentTurnP95Ms: null, agentTokens: 0 },
    ],
  }) as unknown as LeaderboardResult;

/** One place a file can hold a value, and how to put a value there. */
interface Place {
  at: string;
  put(root: object, value: string): void;
}

/**
 * Every place in a run that a file can hold a value: each string, number, boolean and null, each key of an object, and
 * each array, as an object whose `length` is the value, since a report that prints a list's length reads it from
 * whatever the file holds there. report.html's script holds the run as an object literal, where a `__proto__` key sets
 * the object's prototype, so a file can also give it an array's methods: each array is tried that way too.
 */
function placesIn(value: unknown, path: (string | number)[] = []): Place[] {
  const parent = (root: object) => path.reduce<any>((at, key) => at[key], root);
  const set = (root: object, to: unknown) => {
    path.slice(0, -1).reduce<any>((at, key) => at[key], root)[path[path.length - 1]!] = to;
  };
  const at = path.join(".");
  if (Array.isArray(value)) {
    return [
      { at: `${at}.length`, put: (root, v) => set(root, { length: v }) },
      { at: `${at}.length, with an array's methods`, put: (root, v) => set(root, JSON.parse(`{"__proto__":[],"length":${JSON.stringify(v)}}`)) },
      ...value.flatMap((item, i) => placesIn(item, [...path, i])),
    ];
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => [
      {
        at: `${at ? `${at}.` : ""}${key} (its key)`,
        put: (root: object, v: string) => {
          const record = parent(root);
          const held = record[key];
          delete record[key];
          record[v] = held;
        },
      },
      ...placesIn(item, [...path, key]),
    ]);
  }
  return [{ at, put: (root, v) => set(root, v) }];
}

/**
 * Each place in what `fresh` makes where `shows` is true of `render`'s output with `value` there. A render that throws
 * shows nothing, but most must render, or the sweep would pass without looking at anything.
 */
function placesShowing<T extends object>(fresh: () => T, value: string, render: (held: T) => string[], shows: (output: string) => boolean): string[] {
  const places = placesIn(fresh());
  let rendered = 0;
  const found = places.flatMap((place) => {
    const held = fresh();
    place.put(held, value);
    let output: string[];
    try {
      output = render(held);
    } catch {
      return [];
    }
    rendered++;
    return output.some(shows) ? [place.at] : [];
  });
  expect(rendered).toBeGreaterThan(places.length / 2);
  return found;
}

/** The script of report.html without the run it holds, compiled once: compiling it for each place takes most of a sweep's time. */
const compiled = new Map<string, (...args: unknown[]) => void>();

/**
 * Run a report's script against a stand-in for the page, opening each trial, and return all the markup it wrote by
 * element. A value of the wrong type can stop the script: what it wrote before that stays on the page, and a trial can
 * still be opened.
 */
function writtenBy(html: string, trials: readonly [number, number][]): { id: string; markup: string }[] {
  const script = html.slice(html.indexOf("<script>") + "<script>".length, html.indexOf("</script>"));
  const parts = /^\s*const R = ([^\n]*);\nconst C = ([^\n]*);\n([^]*)$/.exec(script);
  if (!parts) throw new Error("report.html's script no longer starts with the run and its comparison");
  const [, run, comparison, code] = parts as unknown as [string, string, string, string];
  const written: { id: string; markup: string }[] = [];
  const document = {
    getElementById: (id: string) => ({
      textContent: "",
      scrollIntoView() {},
      set innerHTML(markup: string) {
        written.push({ id, markup });
      },
    }),
  };
  let show: (task: number, trial: number) => void = () => {};
  const attempt = (step: () => void) => {
    try {
      step();
    } catch {
      // What it wrote so far stands.
    }
  };
  // A function declaration exists from the start, so the script can be stopped and its show still called.
  if (!compiled.has(code)) compiled.set(code, vm.compileFunction(`ready(show);\n${code}`, ["document", "ready", "R", "C"]) as (...args: unknown[]) => void);
  // Read as object literals, as on the page, and not as JSON: a `__proto__` key means something else in each.
  const literal = (text: string): unknown => vm.runInThisContext(`(${text})`);
  attempt(() => compiled.get(code)!(document, (fn: typeof show) => (show = fn), literal(run), literal(comparison)));
  for (const [t, i] of trials) attempt(() => show(t, i));
  return written;
}

const TRIALS = richRun().tasks.flatMap((t, ti) => t.trials.map((_, i) => [ti, i] as [number, number]));

const reportOutput = (r: SuiteResult) => {
  const html = renderHtml(r);
  return [html, ...writtenBy(html, TRIALS).map((w) => w.markup)];
};
const showsTag = (output: string) => output.includes(SHOWN_AS_TAG);

describe("a value from results.json shows as text", () => {
  it("the run these tests walk reaches every section of report.html", () => {
    const filled = writtenBy(renderHtml(richRun()), []).filter((w) => w.markup).map((w) => w.id);
    expect(filled).toEqual(["pending", "kpis", "baseline", "tasks", "flaky", "skipped", "callernotes", "tags", "soft", "judged", "coverage", "modes", "detail"]);
    expect(placesIn(richRun()).length).toBeGreaterThan(400);
  });

  it("in report.html, wherever in the run it is", () => {
    expect(placesShowing(richRun, TAG, reportOutput, showsTag)).toEqual([]);
  });

  it("in the customer report, wherever in the run it is", () => {
    const page = (r: SuiteResult) => [renderCustomerHtml(r)];
    expect(placesShowing(richRun, TAG, page, showsTag)).toEqual([]);
  });

  it("in the customer report with a probe, wherever in either run it is", () => {
    expect(placesShowing(richRun, TAG, (r) => [renderCustomerHtml(r, { probe: carelessRun() })], showsTag)).toEqual([]);
    expect(placesShowing(carelessRun, TAG, (probe) => [renderCustomerHtml(richRun(), { probe })], showsTag)).toEqual([]);
  });

  it("on the leaderboard page, wherever in the board it is", () => {
    expect(placesShowing(richBoard, TAG, (l) => [renderLeaderboardHtml(l)], showsTag)).toEqual([]);
  });

  it("in report --markdown as a tag, wherever in the run it is", () => {
    expect(placesShowing(richRun, TAG, (r) => [renderMarkdown(r)], showsTag)).toEqual([]);
  });

  it("in report --markdown as a link, a table cell or a heading, wherever in the run it is", () => {
    const shows = (md: string) => md.includes("[mark](") || md.includes("a|b") || md.includes("\n# mark");
    expect(placesShowing(richRun, "[mark](https://example.invalid/mark) a|b\n# mark", (r) => [renderMarkdown(r)], shows)).toEqual([]);
  });

  it("in report --markdown as a mention or an issue reference, wherever in the run it is", () => {
    // In a code span, neither does anything.
    const shows = (md: string) => /@mark|#123/.test(md.replace(/`[^`]*`/g, ""));
    expect(placesShowing(richRun, "@mark #123", (r) => [renderMarkdown(r)], shows)).toEqual([]);
  });

  it("in a pass^k's own label, when the run's k is that same value", () => {
    const r = { ...richRun(), k: TAG as never, passHat: { [TAG]: 0.5 } } as SuiteResult;
    expect(reportOutput(r).filter(showsTag)).toEqual([]);
    expect(renderMarkdown(r)).not.toContain(SHOWN_AS_TAG);
    const held = { ...richRun(), k: "@mark" as never, passHat: { "@mark": 0.5 } } as SuiteResult;
    expect(renderMarkdown(held).replace(/`[^`]*`/g, "")).not.toContain("@mark");
  });

  it("reads a marker back where a number or a fixed word usually is", () => {
    const shown = (edit: (r: any) => void) => {
      const r = richRun();
      edit(r);
      return reportOutput(r).join("\n");
    };
    for (const edit of [
      (r: any) => (r.tasks[0].trials[0].turns = TAG),
      (r: any) => (r.tasks[0].trials[0].endReason = TAG),
      (r: any) => (r.tasks[0].trials[0].events[2].via = TAG),
      (r: any) => (r.tasks[0].trials[0].events[0].type = TAG),
      (r: any) => (r.tasks[0].verdict = TAG),
      (r: any) => (r.tasks[0].passes = TAG),
    ]) {
      expect(shown(edit)).toContain(SHOWN_AS_TEXT);
    }
  });

  it("a caller note's own fields don't change which trial its link opens or which task it names", () => {
    const r = richRun() as any;
    r.tasks[0].trials[0].callerNotes[0] = { ...r.tasks[0].trials[0].callerNotes[0], ti: 4, i: 1, task: "another-task" };
    const notes = reportOutput(r).find((w) => w.startsWith("<h2>Caller notes</h2>"))!;
    expect(notes).toContain("onclick='show(0,0);return false'>trial 1</a>");
    expect(notes).toContain("<b>book-load</b>");
    expect(notes).not.toContain("another-task");
  });

  it("the customer report shows a number where it expects text, instead of stopping", () => {
    const r = richRun() as any;
    r.agent = 7001;
    r.runId = 7002;
    r.startedAt = 2026;
    r.tasks[0].description = 7003;
    r.coverage.rules[0].description = 7004;
    const page = renderCustomerHtml(r);
    for (const shown of ["7001", "7002", "2026", "7003", "7004"]) expect(page).toContain(shown);
    const probe = carelessRun() as any;
    probe.agent = 7005;
    expect(renderCustomerHtml(richRun(), { probe })).toContain("7005");
  });

  it("the leaderboard page shows a number where it expects text, instead of stopping", () => {
    const l = richBoard() as any;
    l.domain = 7001;
    l.user = 7002;
    l.rows[0].label = 7003;
    l.rows[0].topFailure = 7004;
    const page = renderLeaderboardHtml(l);
    for (const shown of ["7001", "7002", "7003", "7004"]) expect(page).toContain(shown);
  });
});

describe("a valid run's values read as they did", () => {
  it("in report.html", () => {
    const [, ...written] = reportOutput(richRun());
    const all = written.join("\n");
    for (const shown of [
      "<td class='nw badt'>1/2</td>",
      "<div class='meta'>1 skipped</div>",
      "<span class='badt'>flaky</span>",
      "<td>1 of 2</td>",
      "<td>1</td><td>talks about its instructions</td>",
      "<td class='badt'>1×</td>",
      "<b>tool</b> #3 · via rest",
      "<b>tool</b> #4</small>",
      'class="ev user"><small><b>user</b>',
      "ended: user_stop · 3 turns · 2500ms",
      "caller note, turn 1:",
      "<td>2</td><td>50.0%</td>",
      "1 of 2 trials that called",
      "2 checked<div class='badt'>1 broken</div>",
      "<code>book_load</code> 3×",
      ", k=3. Regressions",
      "<td>3/3</td>",
      "<b>2</b><span>calls stopped at max_tokens</span>",
      "· 2 stopped at max_tokens",
      "<b>2</b><span>replies with reasoning removed</span>",
      "<b>2</b><span>replies silent once reasoning was removed</span>",
      "<td>1</td><td>1</td><td>0</td>",
      "1 pass, 1 fail, 1 not applicable",
      "<b>1</b><span>not judged</span>",
    ]) {
      expect(all).toContain(shown);
    }
  });

  it("in the customer report", () => {
    const page = renderCustomerHtml(richRun());
    for (const shown of ["2 conversations each (7 in all)", "(1 not graded)", "passed 1 of 2", "Broken in 1 of the 2 conversations", "conversation 1", "broken in 1 of 2 conversations where it applied", "2 conversations ended in an error"]) {
      expect(page).toContain(shown);
    }
  });

  it("in report --markdown", () => {
    const md = renderMarkdown(richRun());
    for (const shown of ["k=2", "(pass^2 ", "**pass^2** ", "**Provisional:** 1 drafted", "| 1/2 flaky |", "| 3/3 |", "1×", "1 of 2 trials that called", "1 pass, 1 fail, 1 not applicable", ", 1 not judged", "trial 1, "]) {
      expect(md).toContain(shown);
    }
  });

  it("on the leaderboard page", () => {
    const page = renderLeaderboardHtml(richBoard());
    for (const shown of ["<th>pass^1</th><th>pass^2</th>", "2 times", "<b>pass^2</b> is the share of tasks where all 2 trials passed.", "<td>3</td>", "2 of the domain's 5 tasks 2 times"]) {
      expect(page).toContain(shown);
    }
  });
});
