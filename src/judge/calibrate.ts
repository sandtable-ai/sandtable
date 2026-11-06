import YAML from "yaml";
import { z } from "zod";
import { formatPercent } from "../report/terminal.ts";
import type { TrialResult } from "../run/episode.ts";
import type { SuiteResult, TaskSummary } from "../run/suite.ts";
import type { JudgedVerdict } from "./summary.ts";

/*
 * How often a judge agrees with a person: a person's labels against the verdicts `sandtable judge` stored. No model is
 * called and nothing is written, and the numbers set no gate. A team that wants one can read them in its own code.
 */

const Label = z
  .object({
    task: z.string().min(1),
    trial: z.number().int().min(1, "trial counts from 1, as the terminal prints it"),
    criterion: z.string().min(1),
    label: z.enum(["pass", "fail"]),
  })
  .strict();
const LabelsFile = z.object({ labels: z.array(Label).min(1, "there are no labels: label at least one pair") }).strict();

/** A person's call on one trial and criterion. Someone who thinks a criterion doesn't apply leaves the pair unlabelled. */
export type CalibrationLabel = z.infer<typeof Label>;

/** Labels that are malformed, or that don't fit the run, or a run nothing has judged. */
export class CalibrationError extends Error {}

/** A share, with the number of pairs behind it. With none, `rate` is null, never 0. */
export interface CalibrationRate {
  rate: number | null;
  n: number;
}

/** Each rate is over pairs with both a label and a pass or fail verdict. */
export interface CalibrationCounts {
  /** Of the pairs a person labelled pass, the share the judge gave pass. */
  tpr: CalibrationRate;
  /** Of the pairs a person labelled fail, the share the judge gave fail. */
  tnr: CalibrationRate;
  /** The share where the label and the verdict match. */
  agreement: CalibrationRate;
  /** Labelled pairs whose verdict is not_applicable: outside the rates. */
  notApplicable: number;
  /** Verdicts with no label: outside the rates. */
  unlabelled: number;
}

/** A label with the verdict it met. `trial` counts from 1, as in the label. */
export interface LabelledVerdict extends CalibrationLabel {
  verdict: JudgedVerdict["verdict"];
  quote?: string;
  /** Present only when the quote isn't in the transcript. */
  quoteFound?: false;
  reason: string;
}

/** A label with no verdict to meet, outside every rate, and why there is none. */
export interface LabelWithNoVerdict extends CalibrationLabel {
  why: "skipped" | "failed" | "left_out" | "not_sent";
}

/** One model's numbers, overall, with the same counts per criterion. */
export interface ModelCalibration extends CalibrationCounts {
  model: string;
  /** Every criterion the run names, in spec order. */
  criteria: (CalibrationCounts & { id: string })[];
  disagreements: LabelledVerdict[];
  notApplicablePairs: LabelledVerdict[];
}

export interface Calibration {
  /** One per model the trials hold, in the order they appear: mixing them would measure neither. */
  models: ModelCalibration[];
  /** No model is being measured on these, so they sit apart from `models`. */
  noVerdict: LabelWithNoVerdict[];
}

function checkedLabels(value: unknown, where: string): CalibrationLabel[] {
  const parsed = LabelsFile.safeParse(value);
  if (!parsed.success) throw new CalibrationError(`${where}:\n${z.prettifyError(parsed.error)}`);
  return parsed.data.labels;
}

/** The labels in the text of a YAML or JSON labels file. Throws a CalibrationError saying where it is malformed. */
export function parseLabels(text: string, file: string): CalibrationLabel[] {
  let value: unknown;
  try {
    value = YAML.parse(text);
  } catch (err) {
    throw new CalibrationError(`${file} is not valid YAML or JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return checkedLabels(value, file);
}

/** A skipped trial holds no verdict that counts, as in the judged score. */
const verdictsOf = (trial: TrialResult): JudgedVerdict[] => (trial.skipped ? [] : (trial.judged?.verdicts ?? []));
const pairKey = (task: string, trial: number, criterion: string) => JSON.stringify([task, trial, criterion]);

/** Why these labels can't be read against this run: one line per entry that doesn't fit, or nothing. */
function misfits(run: SuiteResult, labels: readonly CalibrationLabel[]): string[] {
  const named = run.judged!.criteria.map((c) => c.id);
  const holders = new Map<string, Set<string>>();
  const judgedTasks = new Set<string>();
  for (const task of run.tasks) {
    for (const v of task.trials.flatMap(verdictsOf)) {
      judgedTasks.add(task.id);
      holders.set(v.id, (holders.get(v.id) ?? new Set()).add(task.id));
    }
  }
  /*
   * results.json doesn't say which task a criterion belongs to, only what its verdicts show. A task's own criterion
   * applies to that task alone, so verdicts on one other task, while this one has verdicts on something else, put it
   * there. Otherwise nothing shows it has no place here: every trial of this task may have failed, or the judge left it out.
   */
  const placeProblem = (task: TaskSummary, id: string): string | undefined => {
    if (!named.includes(id)) return `this run has no judged criterion ${id}: it has ${named.join(", ")}`;
    const held = holders.get(id);
    if (held?.size === 1 && !held.has(task.id) && judgedTasks.has(task.id)) return `no trial of ${task.id} has a verdict on ${id}, but ${[...held][0]}'s do: it looks like that task's own criterion`;
    return undefined;
  };
  const first = new Map<string, number>();
  return labels.flatMap((l, i) => {
    const task = run.tasks.find((t) => t.id === l.task);
    const trial = task?.trials.find((t) => t.trial === l.trial - 1);
    const key = pairKey(l.task, l.trial, l.criterion);
    const again = first.get(key);
    if (again === undefined) first.set(key, i);
    const problem = !task
      ? `this run has no task ${l.task}`
      : !trial
        ? `${l.task} has no trial ${l.trial} in this run: it has ${task.trials.length}, counted from 1`
        : again !== undefined
          ? `it labels the same pair as labels[${again}]`
          : verdictsOf(trial).some((v) => v.id === l.criterion)
            ? undefined
            : placeProblem(task, l.criterion);
    return problem === undefined ? [] : [`labels[${i}] (${l.task} trial ${l.trial}, ${l.criterion}): ${problem}`];
  });
}

/** Per label given: how many pairs had it, and how many of those the judge gave the same. */
type Tally = Record<CalibrationLabel["label"], { labelled: number; agreed: number }> & { notApplicable: number; unlabelled: number };
const newTally = (): Tally => ({ pass: { labelled: 0, agreed: 0 }, fail: { labelled: 0, agreed: 0 }, notApplicable: 0, unlabelled: 0 });
const rateOf = (hits: number, n: number): CalibrationRate => ({ rate: n > 0 ? hits / n : null, n });
const countsOf = (t: Tally): CalibrationCounts => ({
  tpr: rateOf(t.pass.agreed, t.pass.labelled),
  tnr: rateOf(t.fail.agreed, t.fail.labelled),
  agreement: rateOf(t.pass.agreed + t.fail.agreed, t.pass.labelled + t.fail.labelled),
  notApplicable: t.notApplicable,
  unlabelled: t.unlabelled,
});

/**
 * How often the judge whose verdicts `results` holds agrees with `labels`, per model and per criterion. It does no I/O and
 * calls no model. Throws a CalibrationError, naming each entry, for a run nothing has judged or a label that doesn't fit.
 */
export function calibrate(results: SuiteResult, labels: readonly CalibrationLabel[]): Calibration {
  if (!results.judged) throw new CalibrationError("this run has no judged verdicts: run `npx sandtable-ai judge <results.json> -d <domain>` first");
  const checked = checkedLabels({ labels }, "labels");
  const problems = misfits(results, checked);
  if (problems.length) throw new CalibrationError(`${problems.length === 1 ? "1 label doesn't" : `${problems.length} labels don't`} fit this run:\n  ${problems.join("\n  ")}`);

  const labelled = new Map(checked.map((l) => [pairKey(l.task, l.trial, l.criterion), l]));
  const ids = results.judged.criteria.map((c) => c.id);
  const models = new Map<string, { all: Tally; criteria: Map<string, Tally>; disagreements: LabelledVerdict[]; notApplicablePairs: LabelledVerdict[] }>();
  const withVerdict = new Set<string>();
  for (const task of results.tasks) {
    for (const trial of task.trials) {
      if (!trial.judged) continue;
      if (!models.has(trial.judged.model)) models.set(trial.judged.model, { all: newTally(), criteria: new Map(ids.map((id) => [id, newTally()])), disagreements: [], notApplicablePairs: [] });
      const m = models.get(trial.judged.model)!;
      for (const v of verdictsOf(trial)) {
        const key = pairKey(task.id, trial.trial + 1, v.id);
        withVerdict.add(key);
        if (!m.criteria.has(v.id)) m.criteria.set(v.id, newTally());
        const tallies = [m.all, m.criteria.get(v.id)!];
        const label = labelled.get(key);
        if (!label) {
          for (const t of tallies) t.unlabelled++;
          continue;
        }
        const met: LabelledVerdict = { ...label, verdict: v.verdict, ...(v.quote !== undefined ? { quote: v.quote } : {}), ...(v.quoteFound === false ? { quoteFound: false as const } : {}), reason: v.reason };
        if (v.verdict === "not_applicable") {
          for (const t of tallies) t.notApplicable++;
          m.notApplicablePairs.push(met);
          continue;
        }
        const agreed = v.verdict === label.label;
        for (const t of tallies) {
          t[label.label].labelled++;
          if (agreed) t[label.label].agreed++;
        }
        if (!agreed) m.disagreements.push(met);
      }
    }
  }
  const whyNone = (l: CalibrationLabel): LabelWithNoVerdict["why"] => {
    const trial = results.tasks.find((t) => t.id === l.task)!.trials.find((t) => t.trial === l.trial - 1)!;
    return trial.skipped ? "skipped" : trial.judged?.error !== undefined ? "failed" : trial.judged ? "left_out" : "not_sent";
  };
  return {
    models: [...models].map(([model, m]) => ({
      model,
      ...countsOf(m.all),
      criteria: [...m.criteria].map(([id, t]) => ({ id, ...countsOf(t) })),
      disagreements: m.disagreements,
      notApplicablePairs: m.notApplicablePairs,
    })),
    noVerdict: checked.filter((l) => !withVerdict.has(pairKey(l.task, l.trial, l.criterion))).map((l) => ({ ...l, why: whyNone(l) })),
  };
}

const WHY_NONE: Record<LabelWithNoVerdict["why"], string> = {
  skipped: "its trial was skipped",
  failed: "the judge call failed",
  left_out: "the judge left it out",
  not_sent: "its trial hasn't been judged",
};

const rateCell = (r: CalibrationRate) => `${r.rate === null ? "n/a" : formatPercent(r.rate)} (n=${r.n})`;
const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** A quote and a reason are a model's output, and a quote comes from the transcript of the agent under test: one line of text, nothing a terminal would act on. */
const oneLine = (s: string) => s.replace(/[\s\p{Cc}]+/gu, " ").trim();

function rateTable(m: ModelCalibration): string[] {
  const outside = (c: CalibrationCounts) => [...(c.notApplicable ? [`${c.notApplicable} not applicable`] : []), ...(c.unlabelled ? [`${c.unlabelled} with no label`] : [])].join(", ");
  const rows = [["", "TPR", "TNR", "agreement", "outside the rates"], ...[{ id: "all criteria", ...m }, ...m.criteria].map((c) => [c.id, rateCell(c.tpr), rateCell(c.tnr), rateCell(c.agreement), outside(c)])];
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => `  ${r.map((cell, i) => (i === 0 || i === 4 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!))).join("  ")}`.trimEnd());
}

function pairLines(p: LabelledVerdict): string[] {
  return [
    `    ${p.task} trial ${p.trial} · ${p.criterion}: you said ${p.label}, the judge said ${p.verdict}`,
    ...(p.quote !== undefined ? [`      quote: "${oneLine(p.quote)}"${p.quoteFound === false ? " (not in the transcript)" : ""}`] : []),
    `      reason: ${oneLine(p.reason)}`,
  ];
}

/** The terminal's account of a calibration: the rates with the pairs behind each, what to read, and what stayed outside. */
export function renderCalibration(c: Calibration): string {
  const lines = ["  How often the judge agrees with your labels, over pairs with both a label and a pass or fail verdict.", "  TPR: of the pairs you labelled pass, the share the judge gave pass. TNR: the same for fail. No model was called, and this sets no gate."];
  if (c.models.length > 1) lines.push("", `  This file's trials hold ${c.models.length} judge models, so each is reported apart: mixing them would measure neither. To compare models, keep one results file per model (judge -m <other> -o <dir>) and calibrate each.`);
  if (c.models.length === 0) lines.push("", "  No trial holds a verdict, so there is nothing to measure yet: run npx sandtable-ai judge again.");
  for (const m of c.models) {
    lines.push("", `  Judge ${m.model}`, ...rateTable(m));
    if (m.disagreements.length) lines.push("", `  ${counted(m.disagreements.length, "disagreement", "disagreements")}:`, ...m.disagreements.flatMap(pairLines));
    if (m.notApplicablePairs.length) lines.push("", `  ${counted(m.notApplicablePairs.length, "labelled pair", "labelled pairs")} the judge called not_applicable, outside the rates:`, ...m.notApplicablePairs.flatMap(pairLines));
    if (m.unlabelled) lines.push("", `  ${counted(m.unlabelled, "verdict", "verdicts")} with no label, outside the rates`);
  }
  if (c.noVerdict.length) {
    lines.push("", `  ${counted(c.noVerdict.length, "labelled pair", "labelled pairs")} with no verdict, outside the rates:`);
    for (const p of c.noVerdict) lines.push(`    ${p.task} trial ${p.trial} · ${p.criterion} (you said ${p.label}): ${WHY_NONE[p.why]}`);
  }
  return lines.join("\n");
}
