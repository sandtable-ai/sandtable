import { formatPercent } from "../report/terminal.ts";
import { criticalFailures, skippedTrials, tagsBelowFloor, type SuiteResult } from "./suite.ts";

/** A gate a finished run failed: the line to print, and its exit status (1 a failed gate, 2 an incomplete run). */
export interface FailedGate {
  status: 1 | 2;
  message: string;
}

/**
 * The gates a run that graded something fails, in the order they are printed. `run` and `demo --live` apply the same
 * ones, so a run means the same in both:
 * - skipped trials (exit 2): they are left out of pass^k, so the score rests on fewer trials than asked for, and an
 *   agent that crashes on hard tasks must not pass a gate the others would fail;
 * - a critical task with a failed trial (exit 1): a release blocker, whatever pass^k says;
 * - pass^k below `failUnder` (exit 1);
 * - a tag whose pass^k is below its floor, from `run --floor` and recorded in the result (exit 1).
 */
export function runGates(result: SuiteResult, opts: { failUnder?: number } = {}): FailedGate[] {
  const failed: FailedGate[] = [];
  const skipped = skippedTrials(result);
  if (skipped.length) {
    const trials = result.tasks.reduce((n, t) => n + t.trials.length, 0);
    failed.push({
      status: 2,
      message: `${skipped.length} of ${trials} trial(s) ended in an error before the agent broke any rule, so they were skipped and this run is incomplete: rerun it. The first error:\n  ${skipped[0]!.error ?? "unknown error"}`,
    });
  }
  const blockers = criticalFailures(result);
  if (blockers.length) {
    failed.push({ status: 1, message: `${blockers.length} critical task(s) did not pass every trial: ${blockers.map((t) => `${t.id} ${t.passes}/${t.graded ?? t.trials.length}`).join(", ")}` });
  }
  const score = result.passHat[String(result.k)] ?? 0;
  if (opts.failUnder !== undefined && !(score >= opts.failUnder)) {
    failed.push({ status: 1, message: `pass^${result.k} ${formatPercent(score)} is below --fail-under ${formatPercent(opts.failUnder)}` });
  }
  const below = tagsBelowFloor(result);
  if (below.length) {
    failed.push({ status: 1, message: `${below.length} tag(s) below their --floor: ${below.map((t) => `${t.tag} pass^${result.k} ${formatPercent(t.passHatK)} < ${formatPercent(t.floor)}`).join(", ")}` });
  }
  return failed;
}
