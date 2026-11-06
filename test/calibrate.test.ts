import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { calibrate, CalibrationError, parseLabels, type CalibrationLabel, type JudgedVerdict, type SuiteResult, type TrialResult } from "../src/index.ts";
import { renderCalibration } from "../src/judge/calibrate.ts";
import { loadDomain } from "../src/spec/load.ts";

const MODEL = "claude-sonnet-5-5";
const verdict = (id: string, v: JudgedVerdict["verdict"], extra: Partial<JudgedVerdict> = {}): JudgedVerdict => ({ id, criterion: `${id} text`, verdict: v, reason: `${id} reason`, ...extra });
/** A trial of `taskId` whose call gave these verdicts. */
const judged = (taskId: string, trial: number, verdicts: JudgedVerdict[], model = MODEL) => ({ taskId, trial, judged: { model, verdicts } }) as TrialResult;
/** A trial whose judge call failed, with nothing kept from before. */
const failed = (taskId: string, trial: number) => ({ taskId, trial, judged: { model: MODEL, verdicts: [], error: "overloaded" } }) as unknown as TrialResult;

/** A stored run with these trials, in the shape readResults accepts, naming these criteria in its judged summary. */
function runOf(trials: TrialResult[], criteria = ["reads-back", "polite"]): SuiteResult {
  const tasks = [...new Set(trials.map((t) => t.taskId))].map((id) => ({ id, trials: trials.filter((t) => t.taskId === id) }));
  return { version: 1, domain: "freight", agent: "scripted:careful", passHat: {}, tasks, judged: { pass: 0, fail: 0, notApplicable: 0, score: null, models: [MODEL], notJudged: 0, criteria: criteria.map((id) => ({ id, pass: 0, fail: 0, notApplicable: 0, score: null })), usage: {}, costUsd: null } } as unknown as SuiteResult;
}
const label = (task: string, trial: number, criterion: string, l: CalibrationLabel["label"]): CalibrationLabel => ({ task, trial, criterion, label: l });

// Worked out by hand. reads-back: three labelled pass, of which the judge gave pass twice; two labelled fail, of which it
// gave fail once. polite: one labelled pass, which it gave, and four verdicts with no label.
const SMALL = runOf([
  judged("a", 0, [verdict("reads-back", "pass"), verdict("polite", "pass")]),
  judged("a", 1, [verdict("reads-back", "pass"), verdict("polite", "pass")]),
  judged("a", 2, [verdict("reads-back", "fail", { quote: "Booked.", reason: "No read-back." }), verdict("polite", "pass")]),
  judged("b", 0, [verdict("reads-back", "fail"), verdict("polite", "fail")]),
  judged("b", 1, [verdict("reads-back", "pass", { quote: "Read it back.", quoteFound: false, reason: "It read back." }), verdict("polite", "pass")]),
]);
const SMALL_LABELS = [
  label("a", 1, "reads-back", "pass"),
  label("a", 2, "reads-back", "pass"),
  label("a", 3, "reads-back", "pass"),
  label("b", 1, "reads-back", "fail"),
  label("b", 2, "reads-back", "fail"),
  label("a", 1, "polite", "pass"),
];

describe("calibrate", () => {
  it("counts TPR, TNR and agreement per criterion and overall, each with the pairs behind it", () => {
    const { models } = calibrate(SMALL, SMALL_LABELS);
    expect(models.map((m) => m.model)).toEqual([MODEL]);
    const [m] = models;
    expect(m!.tpr).toEqual({ rate: 3 / 4, n: 4 });
    expect(m!.tnr).toEqual({ rate: 1 / 2, n: 2 });
    expect(m!.agreement).toEqual({ rate: 4 / 6, n: 6 });
    expect(m!.criteria.map((c) => c.id)).toEqual(["reads-back", "polite"]);
    const [readsBack, polite] = m!.criteria;
    expect(readsBack).toMatchObject({ tpr: { rate: 2 / 3, n: 3 }, tnr: { rate: 1 / 2, n: 2 }, agreement: { rate: 3 / 5, n: 5 }, unlabelled: 0 });
    expect(polite).toMatchObject({ tpr: { rate: 1, n: 1 }, agreement: { rate: 1, n: 1 }, unlabelled: 4 });
  });

  it("gives null, never zero, for a rate with no pairs behind it", () => {
    const [m] = calibrate(SMALL, SMALL_LABELS).models;
    expect(m!.criteria[1]!.tnr).toEqual({ rate: null, n: 0 });
    const [none] = calibrate(runOf([judged("a", 0, [verdict("polite", "not_applicable")])]), [label("a", 1, "polite", "pass")]).models;
    expect(none).toMatchObject({ tpr: { rate: null, n: 0 }, tnr: { rate: null, n: 0 }, agreement: { rate: null, n: 0 } });
  });

  it("lists every disagreement, with the quote and the reason", () => {
    const [m] = calibrate(SMALL, SMALL_LABELS).models;
    expect(m!.disagreements).toEqual([
      { task: "a", trial: 3, criterion: "reads-back", label: "pass", verdict: "fail", quote: "Booked.", reason: "No read-back." },
      { task: "b", trial: 2, criterion: "reads-back", label: "fail", verdict: "pass", quote: "Read it back.", quoteFound: false, reason: "It read back." },
    ]);
  });

  it("counts and shows what stays outside the rates, without guessing", () => {
    const run = runOf([
      judged("a", 0, [verdict("reads-back", "pass"), verdict("polite", "not_applicable", { reason: "Nobody was refused." })]),
      // The judge left polite out here, though it judged it on the trial before.
      judged("a", 1, [verdict("reads-back", "pass")]),
      // A verdict on a trial that is skipped counts for nothing, as in the judged score.
      { ...judged("a", 2, [verdict("reads-back", "pass")]), skipped: true } as TrialResult,
      failed("a", 3),
      { taskId: "a", trial: 4 } as TrialResult,
      judged("b", 0, [verdict("reads-back", "fail"), verdict("polite", "not_applicable")]),
    ]);
    const c = calibrate(run, [
      label("a", 1, "reads-back", "pass"),
      label("a", 1, "polite", "fail"),
      label("a", 2, "polite", "pass"),
      label("a", 3, "reads-back", "pass"),
      label("a", 4, "polite", "fail"),
      label("a", 5, "reads-back", "pass"),
    ]);
    const [m] = c.models;
    expect(m!.agreement).toEqual({ rate: 1, n: 1 });
    expect(m!.notApplicable).toBe(1);
    expect(m!.notApplicablePairs).toEqual([{ task: "a", trial: 1, criterion: "polite", label: "fail", verdict: "not_applicable", reason: "Nobody was refused." }]);
    // a trial 2's reads-back, and both of b's.
    expect(m!.unlabelled).toBe(3);
    expect(m!.criteria.map((x) => [x.id, x.notApplicable, x.unlabelled])).toEqual([["reads-back", 0, 2], ["polite", 1, 1]]);
    expect(c.noVerdict.map((p) => [p.task, p.trial, p.criterion, p.label, p.why])).toEqual([
      ["a", 2, "polite", "pass", "left_out"],
      ["a", 3, "reads-back", "pass", "skipped"],
      ["a", 4, "polite", "fail", "failed"],
      ["a", 5, "reads-back", "pass", "not_sent"],
    ]);
  });

  it("reports each model apart when the trials hold more than one", () => {
    const run = runOf([
      judged("a", 0, [verdict("polite", "pass")], "model-one"),
      judged("a", 1, [verdict("polite", "fail")], "model-two"),
      judged("a", 2, [verdict("polite", "pass")], "model-two"),
    ]);
    const c = calibrate(run, [label("a", 1, "polite", "pass"), label("a", 2, "polite", "pass"), label("a", 3, "polite", "pass")]);
    expect(c.models.map((m) => [m.model, m.tpr])).toEqual([
      ["model-one", { rate: 1, n: 1 }],
      ["model-two", { rate: 1 / 2, n: 2 }],
    ]);
    expect(c.models[1]!.disagreements.map((d) => d.trial)).toEqual([2]);
    const text = renderCalibration(c);
    expect(text).toMatch(/2 judge models/);
    expect(text).toMatch(/mixing them would measure neither/);
    expect(text).toContain("judge -m <other> -o <dir>");
    expect(renderCalibration(calibrate(SMALL, SMALL_LABELS))).not.toMatch(/judge models/);
  });

  it("changes nothing it is given", () => {
    const before = structuredClone(SMALL);
    const labels = structuredClone(SMALL_LABELS);
    calibrate(SMALL, SMALL_LABELS);
    expect(SMALL).toEqual(before);
    expect(SMALL_LABELS).toEqual(labels);
  });
});

describe("what calibrate loads", () => {
  /** Every module a file imports at run time, following relative imports; `import type` loads nothing. */
  function loads(file: string, seen = new Set<string>()): Set<string> {
    for (const m of readFileSync(file, "utf8").matchAll(/^(?:import|export) (?!type\b)[^;]*? from "([^"]+)"/gms)) {
      const name = m[1]!;
      const next = name.startsWith(".") ? path.resolve(path.dirname(file), name) : name;
      if (seen.has(next)) continue;
      seen.add(next);
      if (name.startsWith(".")) loads(next, seen);
    }
    return seen;
  }

  it("is neither the judge nor the Anthropic SDK", () => {
    const all = [...loads(path.resolve("src/judge/calibrate.ts"))];
    expect(all).not.toContain(path.resolve("src/judge/judge.ts"));
    expect(all.filter((m) => m.startsWith("@anthropic-ai/"))).toEqual([]);
  });
});

describe("what calibrate refuses", () => {
  const refusal = (run: SuiteResult, labels: CalibrationLabel[]) => {
    try {
      calibrate(run, labels);
    } catch (err) {
      expect(err).toBeInstanceOf(CalibrationError);
      return (err as Error).message;
    }
    throw new Error("expected a refusal");
  };

  it("a run with no judged field says to run judge first", () => {
    const { judged: _, ...never } = SMALL;
    expect(refusal(never as SuiteResult, SMALL_LABELS)).toMatch(/run `npx sandtable-ai judge .*` first/);
  });

  it("a task or trial the run doesn't have, naming the entry", () => {
    expect(refusal(SMALL, [label("a", 1, "polite", "pass"), label("nope", 1, "polite", "pass")])).toMatch(/labels\[1\] \(nope trial 1, polite\): this run has no task nope/);
    expect(refusal(SMALL, [label("a", 4, "polite", "pass")])).toMatch(/labels\[0\] \(a trial 4, polite\): a has no trial 4 .*it has 3/);
  });

  it("a criterion the run doesn't name, with no verdict on the trial", () => {
    expect(refusal(SMALL, [label("a", 1, "politte", "pass")])).toMatch(/labels\[0\] \(a trial 1, politte\): this run has no judged criterion politte: it has reads-back, polite/);
  });

  it("another task's criterion, when its verdicts show it has no place on this task's trials", () => {
    const run = runOf([judged("a", 0, [verdict("polite", "pass")]), judged("a", 1, [verdict("polite", "pass")]), judged("b", 0, [verdict("polite", "pass"), verdict("names-the-date", "pass")])], ["polite", "names-the-date"]);
    expect(refusal(run, [label("a", 1, "names-the-date", "pass")])).toMatch(/labels\[0\] \(a trial 1, names-the-date\): no trial of a has a verdict on names-the-date, but b's do/);
  });

  it("not a criterion that may still apply: the run can't tell, so the pair counts as having no verdict", () => {
    // Every trial of b failed, so nothing shows which of the run's criteria are its own.
    const failedTask = runOf([judged("a", 0, [verdict("polite", "pass")]), failed("b", 0)]);
    expect(calibrate(failedTask, [label("b", 1, "polite", "pass")]).noVerdict.map((p) => p.why)).toEqual(["failed"]);
    // Verdicts on two tasks make it the domain's, so the third task's trial lacks it because the judge left it out.
    const leftOut = runOf([judged("a", 0, [verdict("polite", "pass")]), judged("b", 0, [verdict("polite", "pass")]), judged("c", 0, [verdict("reads-back", "pass")])]);
    expect(calibrate(leftOut, [label("c", 1, "polite", "pass")]).noVerdict.map((p) => p.why)).toEqual(["left_out"]);
    // No verdict on it anywhere, and the run names it.
    const nowhere = runOf([judged("a", 0, [verdict("polite", "pass")])]);
    expect(calibrate(nowhere, [label("a", 1, "reads-back", "pass")]).noVerdict.map((p) => p.why)).toEqual(["left_out"]);
  });

  it("a pair labelled twice, even the same way", () => {
    expect(refusal(SMALL, [label("a", 1, "polite", "pass"), label("a", 2, "polite", "pass"), label("a", 1, "polite", "pass")])).toMatch(/labels\[2\] \(a trial 1, polite\): it labels the same pair as labels\[0\]/);
  });

  it("every entry at once, not one per try", () => {
    const message = refusal(SMALL, [label("nope", 1, "polite", "pass"), label("a", 1, "polite", "pass"), label("a", 9, "polite", "pass")]);
    expect(message).toMatch(/^2 labels don't fit this run/);
    expect(message).toContain("labels[0]");
    expect(message).toContain("labels[2]");
    expect(message).not.toContain("labels[1]");
  });

  it("a label the types would have caught, from a caller without them", () => {
    expect(refusal(SMALL, [{ task: "a", trial: 1, criterion: "polite", label: "Pass" } as unknown as CalibrationLabel])).toMatch(/labels\[0\]\.label/);
  });
});

describe("parseLabels", () => {
  const yaml = "labels:\n  - { task: a, trial: 1, criterion: polite, label: pass }\n  - { task: a, trial: 2, criterion: polite, label: fail }\n";

  it("reads YAML and JSON, with tabs as a JSON file may have", () => {
    expect(parseLabels(yaml, "labels.yaml")).toEqual([label("a", 1, "polite", "pass"), label("a", 2, "polite", "fail")]);
    expect(parseLabels('{\n\t"labels": [\n\t\t{ "task": "a", "trial": 1, "criterion": "polite", "label": "fail" }\n\t]\n}\n', "labels.json")).toEqual([label("a", 1, "polite", "fail")]);
  });

  it.each([
    ["text that doesn't parse", "labels: [", /labels\.yaml is not valid YAML or JSON/],
    ["an empty file", "", /labels\.yaml:\n.*expected object/],
    ["a bare list", "- { task: a, trial: 1, criterion: polite, label: pass }", /labels\.yaml:\n.*expected object/],
    ["no labels", "labels: []", /label at least one pair/],
    ["a key it doesn't know at the top", "labels: [{ task: a, trial: 1, criterion: polite, label: pass }]\nnotes: x", /notes/],
    ["a key it doesn't know on an entry", "labels: [{ task: a, trial: 1, criterion: polite, label: pass, by: Rosa }]", /by[^]*labels\[0\]/],
    ["a label other than pass or fail", "labels: [{ task: a, trial: 1, criterion: polite, label: not_applicable }]", /labels\[0\]\.label/],
    ["a trial counted from 0", "labels: [{ task: a, trial: 0, criterion: polite, label: pass }]", /counts from 1[^]*labels\[0\]\.trial/],
    ["a trial that isn't a whole number", "labels: [{ task: a, trial: 1.5, criterion: polite, label: pass }]", /labels\[0\]\.trial/],
    ["a missing field", "labels: [{ task: a, trial: 1, label: pass }]", /labels\[0\]\.criterion/],
  ])("refuses %s, naming the place", (_, text, expected) => {
    expect(() => parseLabels(text, "labels.yaml")).toThrow(CalibrationError);
    expect(() => parseLabels(text, "labels.yaml")).toThrow(expected);
  });
});

describe("renderCalibration", () => {
  const text = renderCalibration(calibrate(SMALL, SMALL_LABELS));

  it("prints the number of pairs beside every rate, and n/a for a rate with none", () => {
    expect(text).toContain(MODEL);
    expect(text).toMatch(/all criteria\s+75\.0% \(n=4\)\s+50\.0% \(n=2\)\s+66\.7% \(n=6\)/);
    expect(text).toMatch(/reads-back\s+66\.7% \(n=3\)\s+50\.0% \(n=2\)\s+60\.0% \(n=5\)/);
    expect(text).toMatch(/polite\s+100\.0% \(n=1\)\s+n\/a \(n=0\)\s+100\.0% \(n=1\)/);
  });

  it("shows each disagreement's task, trial, criterion, label, verdict, quote and reason", () => {
    expect(text).toContain("a trial 3 · reads-back: you said pass, the judge said fail");
    expect(text).toContain('quote: "Booked."');
    expect(text).toContain("reason: No read-back.");
    expect(text).toContain('quote: "Read it back." (not in the transcript)');
  });

  it("keeps a transcript's line breaks and control characters out of the terminal", () => {
    const run = runOf([judged("a", 0, [verdict("polite", "fail", { quote: "Line one\nline two\x1b[2J", reason: "Two\r\nlines." })])]);
    const out = renderCalibration(calibrate(run, [label("a", 1, "polite", "pass")]));
    expect(out).toContain('quote: "Line one line two [2J"');
    expect(out).toContain("reason: Two lines.");
    expect(out).not.toContain("\x1b");
  });

  it("shows what stays outside the rates, and why a labelled pair has no verdict", () => {
    const run = runOf([judged("a", 0, [verdict("polite", "not_applicable", { reason: "Nobody was refused." }), verdict("reads-back", "pass")]), { taskId: "a", trial: 1, skipped: true } as TrialResult, failed("a", 2)]);
    const out = renderCalibration(calibrate(run, [label("a", 1, "polite", "fail"), label("a", 2, "polite", "pass"), label("a", 3, "polite", "pass")]));
    expect(out).toContain("a trial 1 · polite: you said fail, the judge said not_applicable");
    expect(out).toContain("Nobody was refused.");
    expect(out).toContain("a trial 2 · polite (you said pass): its trial was skipped");
    expect(out).toContain("a trial 3 · polite (you said pass): the judge call failed");
    expect(out).toMatch(/1 verdict with no label/);
    expect(out).toMatch(/2 labelled pairs with no verdict/);
  });

  it("says so when no trial holds a verdict", () => {
    const run = runOf([{ taskId: "a", trial: 0, skipped: true } as TrialResult]);
    expect(renderCalibration(calibrate(run, [label("a", 1, "polite", "pass")]))).toMatch(/No trial holds a verdict/);
  });
});

describe("the guide", () => {
  it("labels tasks and criteria the freight example has, in a file parseLabels reads", async () => {
    const page = readFileSync("docs/guides/calibrate-judged.mdx", "utf8");
    const block = /```yaml\n(labels:[^]*?)```/.exec(page)![1]!;
    const domain = await loadDomain("examples/freight");
    const criteria = domain.judged!.map((c) => c.id);
    const labels = parseLabels(block, "the guide");
    expect(labels.length).toBeGreaterThan(3);
    expect(labels.filter((l) => !domain.tasks.some((t) => t.id === l.task) || !criteria.includes(l.criterion))).toEqual([]);
    expect(new Set(labels.map((l) => l.label))).toEqual(new Set(["pass", "fail"]));
  });
});

describe.skipIf(!process.features.typescript)("the calibrate command", () => {
  const cli = path.resolve("src/cli.ts");
  // No credentials and nowhere to send a call: a model call would fail the run.
  const run = (...args: string[]) =>
    promisify(execFile)(process.execPath, [cli, ...args], { env: { ...process.env, ANTHROPIC_API_KEY: "", ANTHROPIC_BASE_URL: "http://127.0.0.1:9" } }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (e: { code: number; stdout: string; stderr: string }) => e,
    );
  async function files(result: SuiteResult, labels: string, name = "labels.yaml") {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-calibrate-"));
    const results = path.join(dir, "results.json");
    await writeFile(results, JSON.stringify(result));
    const labelsFile = path.join(dir, name);
    await writeFile(labelsFile, labels);
    return { results, labelsFile };
  }
  const small = `labels:\n${SMALL_LABELS.map((l) => `  - ${JSON.stringify(l)}`).join("\n")}\n`;

  it("prints the numbers and exits 0 even when the judge mostly disagrees, leaving the results as they were", async () => {
    const { results, labelsFile } = await files(SMALL, small);
    const before = await readFile(results, "utf8");
    const { code, stdout } = await run("calibrate", results, "--labels", labelsFile);
    expect(code).toBe(0);
    expect(stdout).toContain("sandtable calibrate · freight · agent scripted:careful");
    expect(stdout).toMatch(/all criteria\s+75\.0% \(n=4\)/);
    expect(stdout).toContain("you said pass, the judge said fail");
    expect(await readFile(results, "utf8")).toBe(before);
    const worst = await files(SMALL, "labels:\n  - { task: a, trial: 1, criterion: polite, label: fail }\n");
    expect((await run("calibrate", worst.results, "--labels", worst.labelsFile)).code).toBe(0);
  });

  it("reads a JSON labels file", async () => {
    const { results, labelsFile } = await files(SMALL, JSON.stringify({ labels: SMALL_LABELS }), "labels.json");
    expect((await run("calibrate", results, "--labels", labelsFile)).stdout).toMatch(/all criteria\s+75\.0% \(n=4\)/);
  });

  it.each([
    ["a label on a task the run doesn't have", SMALL, "labels:\n  - { task: nope, trial: 1, criterion: polite, label: pass }\n", /labels\[0\] \(nope trial 1, polite\)/],
    ["a malformed file", SMALL, "labels:\n  - { task: a, trial: one, criterion: polite, label: pass }\n", /labels\[0\]\.trial/],
    ["a pair labelled twice", SMALL, "labels:\n  - { task: a, trial: 1, criterion: polite, label: pass }\n  - { task: a, trial: 1, criterion: polite, label: fail }\n", /same pair as labels\[0\]/],
    ["a run nothing has judged", (({ judged: _, ...rest }) => rest as SuiteResult)(SMALL), small, /npx sandtable-ai judge/],
  ])("refuses %s with exit 2 before printing anything", async (_, result, labels, expected) => {
    const { results, labelsFile } = await files(result, labels);
    const { code, stdout, stderr } = await run("calibrate", results, "--labels", labelsFile);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toMatch(expected);
  });

  it("names a labels file that isn't there, and requires the option", async () => {
    const { results, labelsFile } = await files(SMALL, small);
    const missing = await run("calibrate", results, "--labels", `${labelsFile}.gone`);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain(`--labels: no file at ${labelsFile}.gone`);
    const without = await run("calibrate", results);
    expect(without.code).toBe(2);
    expect(without.stderr).toMatch(/--labels/);
  });
});
