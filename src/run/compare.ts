import { passHatK } from "../grade/passk.ts";
import type { SuiteResult } from "./suite.ts";

/**
 * What a run keeps of the earlier run it was compared with (`run --baseline`): enough to show what
 * changed task by task, so `report` and `regrade` can show it again without the earlier file.
 */
export interface BaselineSnapshot {
  runId: string;
  startedAt: string;
  agent: string;
  user: string;
  k: number;
  /** The baseline's inputs fingerprint; absent when its results.json is older than the fingerprint. */
  inputs?: string;
  /** The baseline's own pass^1 .. pass^k, over all of its tasks. */
  passHat: Record<string, number>;
  /** Trials passed and run, per task, in the baseline's order. */
  tasks: { id: string; passes: number; trials: number }[];
}

/**
 * How a task's result moved since the baseline. `broken`: it passed every trial then, and fails some now.
 * `fixed`: the reverse. `worse` and `better`: its pass rate moved without crossing passing every trial.
 * `added`: only this run has it. `removed`: only the baseline has it, because the task is gone or `-t`
 * left it out.
 */
export type TaskChange = "broken" | "worse" | "fixed" | "better" | "same" | "added" | "removed";

export interface TaskDelta {
  id: string;
  change: TaskChange;
  /** Absent for an added task. */
  before?: { passes: number; trials: number };
  /** Absent for a removed task. */
  after?: { passes: number; trials: number };
}

export interface Comparison {
  baseline: BaselineSnapshot;
  /** Every task of either run: regressions first (broken, worse), then fixed, better, added, removed, same. */
  tasks: TaskDelta[];
  /** Both runs ran exactly the same tasks. */
  sameTasks: boolean;
  /** Tasks both runs ran; pass^j below is over these. */
  shared: number;
  /** pass^j before and after, over the tasks both runs ran, for every j up to the smaller k. */
  passHat: { j: number; before: number; after: number }[];
  /** What else differs between the runs, in words, e.g. `agent scripted:careful → scripted:naive`. */
  differences: string[];
}

const ORDER: TaskChange[] = ["broken", "worse", "fixed", "better", "added", "removed", "same"];

/** The part of a run that a later run keeps as its baseline. */
export function baselineSnapshot(r: SuiteResult): BaselineSnapshot {
  return {
    runId: r.runId,
    startedAt: r.startedAt,
    agent: r.agent,
    user: r.user,
    k: r.k,
    ...(r.inputs ? { inputs: r.inputs } : {}),
    passHat: r.passHat,
    tasks: r.tasks.map((t) => ({ id: t.id, passes: t.trials.filter((tr) => tr.passed).length, trials: t.trials.length })),
  };
}

/** The share of trials passed, or NaN for a task with no trials. */
const rate = (x: { passes: number; trials: number }) => x.passes / x.trials;
const allPass = (x: { passes: number; trials: number }) => x.trials > 0 && x.passes === x.trials;

function change(before: { passes: number; trials: number }, after: { passes: number; trials: number }): TaskChange {
  if (allPass(before) && !allPass(after)) return "broken";
  if (!allPass(before) && allPass(after)) return "fixed";
  if (rate(after) < rate(before)) return "worse";
  if (rate(after) > rate(before)) return "better";
  return "same";
}

/** A task's verdicts as booleans, for pass^j: `passes` trues then the failures. */
const outcomes = (x: { passes: number; trials: number }) => Array.from({ length: x.trials }, (_, i) => i < x.passes);

/**
 * Compare a run with an earlier run of the same domain, task by task. pass^j is compared over the tasks
 * both runs ran, for every j up to the smaller of the two k, since the runs may differ in tasks and k.
 */
export function compareRuns(baseline: BaselineSnapshot, now: SuiteResult): Comparison {
  const before = new Map(baseline.tasks.map((t) => [t.id, { passes: t.passes, trials: t.trials }]));
  const after = new Map(now.tasks.map((t) => [t.id, { passes: t.trials.filter((tr) => tr.passed).length, trials: t.trials.length }]));
  const deltas: TaskDelta[] = [];
  for (const [id, a] of after) {
    const b = before.get(id);
    deltas.push(b ? { id, change: change(b, a), before: b, after: a } : { id, change: "added", after: a });
  }
  for (const [id, b] of before) if (!after.has(id)) deltas.push({ id, change: "removed", before: b });
  deltas.sort((x, y) => ORDER.indexOf(x.change) - ORDER.indexOf(y.change));

  const shared = now.tasks.map((t) => t.id).filter((id) => before.has(id));
  const passHat: Comparison["passHat"] = [];
  for (let j = 1; j <= Math.min(baseline.k, now.k); j++) {
    passHat.push({
      j,
      before: passHatK(shared.map((id) => outcomes(before.get(id)!)), j),
      after: passHatK(shared.map((id) => outcomes(after.get(id)!)), j),
    });
  }

  const sameTasks = shared.length === before.size && shared.length === after.size;
  const differences: string[] = [];
  if (baseline.agent !== now.agent) differences.push(`agent ${baseline.agent} → ${now.agent}`);
  if (baseline.user !== now.user) differences.push(`simulated user ${baseline.user} → ${now.user}`);
  if (baseline.k !== now.k) differences.push(`k ${baseline.k} → ${now.k}: pass^j compared up to j=${Math.min(baseline.k, now.k)}`);
  // The fingerprint covers the tasks run and, for the scripted user, the scripts, so it only says
  // something new when both runs ran the same tasks under the same simulated user.
  if (sameTasks && baseline.user === now.user && baseline.inputs && now.inputs && baseline.inputs !== now.inputs) {
    differences.push("prompts changed: the policy, a tool's schema or a task's caller prompt");
  }
  return { baseline, tasks: deltas, sameTasks, shared: shared.length, passHat, differences };
}

/** The comparison stored with a run, or undefined for a run made without `--baseline`. */
export function comparisonOf(r: SuiteResult): Comparison | undefined {
  return r.baseline ? compareRuns(r.baseline, r) : undefined;
}

/** Throw unless `baseline` is a run of the domain named `domain`. */
export function checkBaseline(baseline: SuiteResult, domain: string, file: string): void {
  if (baseline.domain !== domain) {
    throw new Error(`${file} is a run of ${baseline.domain}, not ${domain}, so it can't be this run's baseline: pass a results.json of ${domain}`);
  }
}
