import type { TrialResult } from "../run/episode.ts";
import type { SuiteResult } from "../run/suite.ts";
import { costOf, type UsageByModel } from "../run/usage.ts";
import { resolveDates } from "../spec/clock.ts";
import type { Domain, Task } from "../spec/schema.ts";

/*
 * The judged score, apart from pass/fail: what `sandtable judge` stores and how it counts. A verdict is a model's
 * output, so it changes no verdict, pass^k, gate or exit code. This module has no model code, so `regrade` can use it
 * without loading the Anthropic SDK; the call itself is in judge.ts.
 */

/** One criterion's verdict on one trial. */
export interface JudgedVerdict {
  id: string;
  /** The criterion's text as resolved at the trial's clock: what the judge read. */
  criterion: string;
  verdict: "pass" | "fail" | "not_applicable";
  /** From the transcript, supporting the verdict. */
  quote?: string;
  /** Present only when the quote isn't in the transcript. */
  quoteFound?: false;
  reason: string;
}

/** A trial's judgement: the verdicts it has, and why the last call for it failed, if it did. */
export interface TrialJudgement {
  model: string;
  verdicts: JudgedVerdict[];
  error?: string;
}

export interface JudgedCounts {
  pass: number;
  fail: number;
  notApplicable: number;
  /** pass / (pass + fail), null with neither: a rate over verdicts, not pass^k. */
  score: number | null;
}

export interface JudgedSummary extends JudgedCounts {
  /** The models whose verdicts the trials hold. */
  models: string[];
  /** Trial-and-criterion pairs with no verdict: a skipped trial, a failed call or a criterion the judge left out. */
  notJudged: number;
  /** In spec order. `pending` marks a criterion still `review: pending`. */
  criteria: (JudgedCounts & { id: string; pending?: true })[];
  /** The judge's tokens, every call for this file's verdicts included. The run's own `usage` never has them. */
  usage: UsageByModel;
  costUsd: number | null;
}

/** A criterion as it applies to one trial: its text with dates resolved at the trial's clock. */
export interface AppliedCriterion {
  id: string;
  criterion: string;
  pending?: true;
}

/** The criteria that apply to a stored trial (see storedCriteria in regrade.ts). */
export type CriteriaOf = (trial: Pick<TrialResult, "taskId" | "clock">) => AppliedCriterion[];

/** Whether any criterion, as written, applies to a task of this run. */
export function statesCriteria(domain: Domain, run: Pick<SuiteResult, "tasks">): boolean {
  return run.tasks.some((s) => (domain.judged?.length ?? 0) > 0 || (domain.tasks.find((t) => t.id === s.id)?.judged?.length ?? 0) > 0);
}

/** The criteria that apply to a trial of `task`: the domain's, then the task's, with dates resolved at `clock` when it has one. */
export function appliedCriteria(domain: Domain, task: Task, clock: string | undefined): AppliedCriterion[] {
  const written = [...(domain.judged ?? []), ...(task.judged ?? [])];
  if (written.length === 0) return [];
  const resolved = clock === undefined ? { domain, task } : resolveDates(domain, task, clock);
  return [...(resolved.domain.judged ?? []), ...(resolved.task.judged ?? [])].map((c) => ({ id: c.id, criterion: c.criterion, ...(c.review === "pending" ? { pending: true as const } : {}) }));
}

/** Why a stored verdict no longer counts for its trial, or undefined while it does. */
export function staleBecause(v: JudgedVerdict, trial: Pick<TrialResult, "skipped">, criteria: readonly AppliedCriterion[]): string | undefined {
  if (trial.skipped) return "its trial is now skipped";
  const applied = criteria.find((c) => c.id === v.id);
  if (!applied) return "its criterion no longer applies";
  return applied.criterion === v.criterion ? undefined : "its criterion's text changed";
}

/** The trial without the verdicts that no longer count; with none left and no error to tell, without `judged`. */
export function pruneVerdicts(trial: TrialResult, criteria: readonly AppliedCriterion[]): TrialResult {
  if (!trial.judged) return trial;
  const kept = trial.judged.verdicts.filter((v) => staleBecause(v, trial, criteria) === undefined);
  if (kept.length === trial.judged.verdicts.length && !trial.skipped) return trial;
  const { judged, ...rest } = trial;
  return kept.length || (judged.error !== undefined && !trial.skipped) ? { ...rest, judged: { ...judged, verdicts: kept } } : rest;
}

/** "2 stored judged verdict(s) dropped: 1 because its criterion no longer applies, 1 because its criterion's text changed" */
export function droppedLine(reasons: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  const why = [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([r, n]) => `${n} because ${r}`);
  return `${reasons.length} stored judged verdict(s) dropped: ${why.join(", ")}`;
}

type Tally = Pick<JudgedCounts, "pass" | "fail" | "notApplicable">;
const FIELD = { pass: "pass", fail: "fail", not_applicable: "notApplicable" } as const;
const counted = (t: Tally): JudgedCounts => ({ ...t, score: t.pass + t.fail > 0 ? t.pass / (t.pass + t.fail) : null });

/**
 * The run with its judged counts worked out from its trials' verdicts: per task, per criterion and for the run. Every
 * other field stays as it is. A verdict counts while it is on a graded trial, for a criterion that applies to it, with
 * the same text. A run with nothing judged and no judge calls paid for gets no field at all.
 */
export function withJudgedSummary(run: SuiteResult, criteriaOf: CriteriaOf, usage: UsageByModel = run.judged?.usage ?? {}): SuiteResult {
  const total: Tally = { pass: 0, fail: 0, notApplicable: 0 };
  const criteria = new Map<string, Tally & { id: string; pending?: true }>();
  const models = new Set<string>();
  let notJudged = 0;
  const tasks = run.tasks.map(({ judged: _, ...task }) => {
    const own: Tally = { pass: 0, fail: 0, notApplicable: 0 };
    let any = false;
    for (const trial of task.trials) {
      if (trial.judged) models.add(trial.judged.model);
      for (const c of criteriaOf(trial)) {
        if (!criteria.has(c.id)) criteria.set(c.id, { id: c.id, ...(c.pending ? { pending: true as const } : {}), pass: 0, fail: 0, notApplicable: 0 });
        const v = trial.skipped ? undefined : trial.judged?.verdicts.find((x) => x.id === c.id && x.criterion === c.criterion);
        if (!v) {
          notJudged++;
          continue;
        }
        any = true;
        for (const t of [total, own, criteria.get(c.id)!]) t[FIELD[v.verdict]]++;
      }
    }
    return any ? { ...task, judged: counted(own) } : task;
  });
  const { judged: _, ...rest } = run;
  if (models.size === 0 && Object.keys(usage).length === 0) return { ...rest, tasks };
  return {
    ...rest,
    tasks,
    judged: {
      ...counted(total),
      models: [...models],
      notJudged,
      criteria: [...criteria.values()].map((c) => ({ ...c, ...counted(c) })),
      usage,
      costUsd: costOf(usage),
    },
  };
}
