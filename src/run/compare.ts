import { passHatK } from "../grade/passk.ts";
import type { SuiteResult, TaskSummary } from "./suite.ts";

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
  /**
   * Trials passed and graded per task, in the baseline's order: skipped trials are left out, as in pass^k. With
   * each task's `inputs` and `grading` hashes, absent when the baseline's results.json is older than them.
   */
  tasks: { id: string; passes: number; trials: number; inputs?: string; grading?: string }[];
}

/**
 * How a task's result moved since the baseline. `broken`: it passed every trial then, and fails some now.
 * `fixed`: the reverse. `worse` and `better`: its pass rate moved without crossing passing every trial.
 * `added`: only this run has it. `removed`: only the baseline has it, because the task is gone or `-t`
 * left it out. `skipped`: one of the runs graded none of its trials (each ended in an error), so there is
 * nothing to compare. `changed`: the task's test changed since the baseline (what the agent or caller is given,
 * the world, or how it's graded), so a move in its result can't be put down to the agent.
 */
export type TaskChange = "broken" | "worse" | "fixed" | "better" | "changed" | "same" | "added" | "removed" | "skipped";

export interface TaskDelta {
  id: string;
  change: TaskChange;
  /** Absent for an added task. */
  before?: { passes: number; trials: number };
  /** Absent for a removed task. */
  after?: { passes: number; trials: number };
  /** For a `changed` task, which of its hashes differ from the baseline's. */
  what?: ("inputs" | "grading")[];
}

export interface Comparison {
  baseline: BaselineSnapshot;
  /** Every task of either run: regressions first (broken, worse), then fixed, better, added, removed, same. */
  tasks: TaskDelta[];
  /** Both runs ran exactly the same tasks. */
  sameTasks: boolean;
  /** Tasks both runs ran. */
  shared: number;
  /** Tasks both runs ran whose test didn't change; pass^j below is over these. */
  comparable: number;
  /** pass^j before and after, over the comparable tasks, for every j up to the smaller k. */
  passHat: { j: number; before: number; after: number }[];
  /** What else differs between the runs, in words, e.g. `agent scripted:careful → scripted:naive`. */
  differences: string[];
}

const ORDER: TaskChange[] = ["broken", "worse", "fixed", "better", "changed", "added", "removed", "skipped", "same"];

/** A task's passes out of its graded trials; results from before verdicts graded every trial. */
const counts = (t: TaskSummary) => ({ passes: t.passes, trials: t.graded ?? t.trials.length });

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
    tasks: r.tasks.map((t) => ({ id: t.id, ...counts(t), ...(t.inputs ? { inputs: t.inputs } : {}), ...(t.grading ? { grading: t.grading } : {}) })),
  };
}

/** The share of graded trials passed, or NaN for a task with none. */
const rate = (x: { passes: number; trials: number }) => x.passes / x.trials;
const allPass = (x: { passes: number; trials: number }) => x.trials > 0 && x.passes === x.trials;

function change(before: { passes: number; trials: number }, after: { passes: number; trials: number }): TaskChange {
  if (before.trials === 0 || after.trials === 0) return "skipped";
  if (allPass(before) && !allPass(after)) return "broken";
  if (!allPass(before) && allPass(after)) return "fixed";
  if (rate(after) < rate(before)) return "worse";
  if (rate(after) > rate(before)) return "better";
  return "same";
}

/** A task's verdicts as booleans, for pass^j: `passes` trues then the failures. */
const outcomes = (x: { passes: number; trials: number }) => Array.from({ length: x.trials }, (_, i) => i < x.passes);

/**
 * Compare a run with an earlier run of the same domain, task by task. A task whose test changed since the
 * baseline (its `inputs` or `grading` hash differs) is `changed`, not fixed or broken, and pass^j is compared
 * over the tasks both runs ran with the same test, for every j up to the smaller of the two k.
 */
export function compareRuns(baseline: BaselineSnapshot, now: SuiteResult): Comparison {
  const base = new Map(baseline.tasks.map((t) => [t.id, t]));
  const before = new Map(baseline.tasks.map((t) => [t.id, { passes: t.passes, trials: t.trials }]));
  const after = new Map(now.tasks.map((t) => [t.id, counts(t)]));
  // A baseline written before per-task hashes can't show whether a task's test changed.
  const perTask = baseline.tasks.length > 0 && baseline.tasks.every((t) => t.inputs !== undefined && t.grading !== undefined);
  const testChanges = (t: TaskSummary): ("inputs" | "grading")[] => {
    const b = base.get(t.id);
    if (!perTask || !b) return [];
    return [
      ...(t.inputs !== undefined && t.inputs !== b.inputs ? (["inputs"] as const) : []),
      ...(t.grading !== undefined && t.grading !== b.grading ? (["grading"] as const) : []),
    ];
  };
  const deltas: TaskDelta[] = [];
  for (const t of now.tasks) {
    const a = after.get(t.id)!;
    const b = before.get(t.id);
    const what = testChanges(t);
    if (!b) deltas.push({ id: t.id, change: "added", after: a });
    else if (what.length) deltas.push({ id: t.id, change: "changed", before: b, after: a, what });
    else deltas.push({ id: t.id, change: change(b, a), before: b, after: a });
  }
  for (const [id, b] of before) if (!after.has(id)) deltas.push({ id, change: "removed", before: b });
  deltas.sort((x, y) => ORDER.indexOf(x.change) - ORDER.indexOf(y.change));

  const shared = now.tasks.map((t) => t.id).filter((id) => before.has(id));
  const changed = new Set(deltas.filter((d) => d.change === "changed").map((d) => d.id));
  const comparable = shared.filter((id) => !changed.has(id));
  const passHat: Comparison["passHat"] = [];
  for (let j = 1; j <= Math.min(baseline.k, now.k); j++) {
    passHat.push({
      j,
      before: passHatK(comparable.map((id) => outcomes(before.get(id)!)), j),
      after: passHatK(comparable.map((id) => outcomes(after.get(id)!)), j),
    });
  }

  const sameTasks = shared.length === before.size && shared.length === after.size;
  const differences: string[] = [];
  if (baseline.agent !== now.agent) differences.push(`agent ${baseline.agent} → ${now.agent}`);
  if (baseline.user !== now.user) differences.push(`simulated user ${baseline.user} → ${now.user}`);
  if (baseline.k !== now.k) differences.push(`k ${baseline.k} → ${now.k}: pass^j compared up to j=${Math.min(baseline.k, now.k)}`);
  if (perTask) {
    const given = deltas.filter((d) => d.what?.includes("inputs")).length;
    const graded = deltas.filter((d) => d.what?.includes("grading")).length;
    const tasks = (n: number) => `${n} task${n === 1 ? "" : "s"}`;
    if (given) differences.push(`what the agent or caller is given changed for ${tasks(given)}`);
    if (graded) differences.push(`how it's graded changed for ${tasks(graded)}`);
  } else if (shared.length) {
    differences.push("the baseline has no per-task fingerprints: a changed test looks like a fix");
    // The run's fingerprint covers the tasks run and, for the scripted user, the scripts, so it only says
    // something new when both runs ran the same tasks under the same simulated user.
    if (sameTasks && baseline.user === now.user && baseline.inputs && now.inputs && baseline.inputs !== now.inputs) {
      differences.push("prompts changed: the policy, a tool's schema or a task's caller prompt");
    }
  }
  return { baseline, tasks: deltas, sameTasks, shared: shared.length, comparable: comparable.length, passHat, differences };
}

/**
 * The tasks that fail `--fail-on-regression`: those that passed every graded trial in the baseline and fail one now,
 * with the same test. A `worse` task never passed every trial, and with a few trials its move is often noise; a
 * `changed` task's test differs, so its move can't be put down to the agent.
 */
export function regressions(c: Comparison): TaskDelta[] {
  return c.tasks.filter((d) => d.change === "broken");
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
