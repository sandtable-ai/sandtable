import type { CheckKind } from "../grade/expectations.ts";
import { invariantTool } from "../grade/invariants.ts";
import { lintDomain, type LintReport } from "../grade/lint.ts";
import { passAtK, passHatK, wilsonInterval } from "../grade/passk.ts";
import { pendingReview, type PendingItem } from "../spec/load.ts";
import type { Domain, Task } from "../spec/schema.ts";
import type { AgentPromptOptions } from "../sim/prompts.ts";
import type { AgentAdapter, UserSimulator } from "../sim/types.ts";
import { attributeTrial, attributionCounts, type AttributionCounts } from "./attribution.ts";
import type { BaselineSnapshot } from "./compare.ts";
import { coverageOf, type Coverage } from "./coverage.ts";
import { runEpisode, type TrialResult } from "./episode.ts";
import type { WorldServer } from "../serve/server.ts";
import { inputsFingerprint, taskFingerprints } from "./inputs.ts";
import { percentile, sumUsage, type Usage } from "./usage.ts";
import { version } from "../version.ts";

/**
 * A task's verdict over its graded trials: `passed` when every one passed, `failed` when none did, `flaky`
 * when some did, and `skipped` when every trial was skipped, so nothing about the agent was graded.
 */
export type Verdict = "passed" | "failed" | "flaky" | "skipped";

export interface TaskSummary {
  id: string;
  description?: string;
  tags: string[];
  /** Set only on a critical task: any failed trial fails `sandtable run`. */
  critical?: true;
  trials: TrialResult[];
  /** Trials that passed. */
  passes: number;
  /** Trials that were graded: all of them but the skipped ones. Absent in results from before verdicts. */
  graded?: number;
  /** Trials skipped because they ended in an error before the agent broke a rule. */
  skipped?: number;
  verdict?: Verdict;
  /** The 95% Wilson score interval for passes / graded; absent when no trial was graded. */
  interval?: { low: number; high: number };
  /**
   * Short hashes of the task's test (see taskFingerprints): `inputs`, what the agent and the caller are given and
   * the world they act in, and `grading`, how its trials are graded. `run --baseline` labels a task whose hashes
   * differ from the baseline's as changed instead of fixed or broken. Absent in results from before them.
   */
  inputs?: string;
  grading?: string;
}

export interface FailureMode {
  id: string;
  kind: CheckKind;
  /** Failed trials containing this check. */
  count: number;
  tasks: string[];
  example: string;
}

/**
 * How often a soft invariant was broken across the run. Soft invariants never fail a trial;
 * this is the number to read instead, e.g. how often counter-offers reached the price ceiling.
 */
export interface SoftScore {
  id: string;
  description: string;
  /** The tool whose calls it checks; absent for never_disclose, which checks what the agent says. */
  tool?: string;
  /** Trials in which it applied: its tool was called, or for never_disclose, the agent spoke. */
  applied: number;
  /** Trials in which it was broken at least once. */
  broken: number;
  /** broken / applied; null when it never applied. */
  rate: number | null;
  /** Tasks with at least one trial that broke it. */
  tasks: string[];
  /** The first violation's detail. */
  example?: string;
}

export interface SuiteResult {
  version: 1;
  /**
   * The sandtable-ai that wrote this file: `version` ran the trials, and `regradedWith` re-scored them, when
   * `sandtable regrade` did. Absent in results from before 0.3.0; `version` is absent when such a run is regraded.
   */
  sandtable?: { version?: string; regradedWith?: string };
  /** Unique per run; prefixes agent session ids (`<runId>/<task-id>#<trial>`). */
  runId: string;
  domain: string;
  /** The agent's name; ` (without policy)` follows it in a `run --without-policy` run. */
  agent: string;
  /**
   * Set by `run --without-policy`: the agent was prompted without the domain's policy, a careless agent whose broken
   * rules show which ones the tasks catch. `regrade` grades its trials with the same prompt. Absent otherwise.
   */
  withoutPolicy?: true;
  user: string;
  k: number;
  /**
   * A hash of what the agent and the simulated user were given for these tasks: the agent's prompt and tool
   * schemas, and each task's caller prompt, opening and turn limit (and script, for the scripted user).
   * `sandtable regrade` re-scores a run only while it is unchanged. Absent in results from before regrade.
   */
  inputs?: string;
  startedAt: string;
  durationMs: number;
  tasks: TaskSummary[];
  /** pass^1 .. pass^k over graded trials. A task with fewer than j graded trials is left out of pass^j. */
  passHat: Record<string, number>;
  /** pass@1 .. pass@k over graded trials, left out the same way. Absent in results from before verdicts. */
  passAt?: Record<string, number>;
  /**
   * The share of tasks with at least 2 graded trials that passed some and failed others (flaky), from 0 to 1;
   * null when no task has 2 graded trials, as with k = 1.
   */
  flipRate?: number | null;
  /** Ids of the flaky tasks, in spec order. */
  flaky?: string[];
  /** Trials skipped because they ended in an error before the agent broke a rule. */
  skipped?: number;
  /**
   * Caller turns in which the simulated user stepped out of its role (each trial's `callerNotes`), and the
   * trials they are in. Absent in results from before caller notes.
   */
  callerNotes?: { turns: number; trials: number };
  /**
   * Trials that didn't pass (failed or skipped), by the owner each trial's `attribution` names. Scores don't
   * depend on it. Absent in results from before attribution, until `sandtable regrade` re-scores them.
   */
  attribution?: AttributionCounts;
  failureModes: FailureMode[];
  /** pass^1 and pass^k per task tag ("untagged" for tasks without tags). */
  byTag: TagScore[];
  /** One entry per soft invariant in the domain, in spec order. Empty when there are none. */
  soft: SoftScore[];
  /**
   * What the run checked: for each rule, the tasks whose trials checked it and the trials that broke it, and for each
   * tool, the trials that called it. Absent in results from before coverage, until `sandtable regrade` re-scores them.
   */
  coverage?: Coverage;
  usage: Usage;
  /** Drafted items not yet accepted; while non-empty, results are provisional. */
  pendingReview: PendingItem[];
  /** Time the agent took to answer each user turn, tool calls included. */
  latency: { agentTurnP50Ms: number | null; agentTurnP95Ms: number | null };
  /** The earlier run this one was compared with (`run --baseline`); reports show what changed since. */
  baseline?: BaselineSnapshot;
  /**
   * `run --floor <tag>=<pct>`: the least pass^k each tag must reach, as a fraction like `passHat`, in the order given.
   * Absent without `--floor`.
   */
  floors?: Record<string, number>;
}

export interface TagScore {
  tag: string;
  tasks: number;
  passHat1: number;
  passHatK: number;
}

export interface SuiteOptions {
  domain: Domain;
  agent: AgentAdapter;
  user: UserSimulator;
  /** Trials per task. pass^k is reported for every j <= k. */
  k?: number;
  taskIds?: string[];
  concurrency?: number;
  onTrial?: (result: TrialResult) => void;
  /**
   * Prompt the agent without the domain's policy (`run --without-policy`): `ctx.system` keeps the generic instructions
   * and the task's context. It means something only for an agent that takes `ctx.system` as its prompt, as the
   * built-in model agents do. The result's `agent` name gets ` (without policy)`, and it records `withoutPolicy`.
   */
  withoutPolicy?: boolean;
  /**
   * Serve each trial's world on this server while the trial runs (`run --serve`, startWorldServer): the agent gets the
   * trial's URLs as `ctx.world`, and its calls over REST, MCP or a webhook are graded like in-process ones.
   */
  server?: WorldServer;
}

export async function runSuite(opts: SuiteOptions): Promise<SuiteResult> {
  const { domain, agent, user } = opts;
  const k = opts.k ?? 1;
  const prompt: AgentPromptOptions = opts.withoutPolicy ? { withoutPolicy: true } : {};
  const startedAt = new Date().toISOString();
  // e.g. 20261018T210512-k3f9: sortable and unique per run, used to namespace agent session ids.
  const runId = `${startedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "")}-${Math.random().toString(36).slice(2, 6)}`;
  const started = performance.now();

  const tasks = opts.taskIds?.length ? domain.tasks.filter((t) => opts.taskIds!.includes(t.id)) : domain.tasks;
  const missing = (opts.taskIds ?? []).filter((id) => !domain.tasks.some((t) => t.id === id));
  if (missing.length) throw new Error(`unknown task id(s): ${missing.join(", ")}`);

  const jobs = tasks.flatMap((task) => Array.from({ length: k }, (_, trial) => ({ task, trial })));
  const results = await pool(jobs, opts.concurrency ?? 4, async ({ task, trial }) => {
    const r = await runEpisode({ domain, task, agent, user, trial, runId, prompt, ...(opts.server ? { server: opts.server } : {}) });
    opts.onTrial?.(r);
    return r;
  });

  const turnLatencies = results.flatMap((r) => r.events.flatMap((e) => (e.type === "agent" ? [e.latencyMs] : [])));

  return {
    version: 1,
    sandtable: { version },
    runId,
    domain: domain.name,
    agent: opts.withoutPolicy ? `${agent.name} (without policy)` : agent.name,
    ...(opts.withoutPolicy ? { withoutPolicy: true as const } : {}),
    user: user.name,
    k,
    inputs: inputsFingerprint(domain, tasks.map((t) => t.id), user.name, prompt),
    startedAt,
    durationMs: Math.round(performance.now() - started),
    ...summarize(domain, tasks, results, k, user.name, prompt),
    usage: sumUsage(results.map((r) => r.usage)),
    pendingReview: pendingReview(domain),
    latency: { agentTurnP50Ms: percentile(turnLatencies, 50), agentTurnP95Ms: percentile(turnLatencies, 95) },
  };
}

/** Per-task results and the scores derived from the verdicts, for a live run or a regrade. */
export function summarize(
  domain: Domain,
  tasks: readonly Task[],
  results: readonly TrialResult[],
  k: number,
  /** The simulated user's name, which decides whether the task's script is part of its `inputs` hash. */
  user: string,
  /** How the agent was prompted (`run --without-policy`), part of each task's `inputs` hash and of coverage. */
  prompt: AgentPromptOptions = {},
): Pick<SuiteResult, "tasks" | "passHat" | "passAt" | "flipRate" | "flaky" | "skipped" | "callerNotes" | "attribution" | "failureModes" | "byTag" | "soft" | "coverage"> {
  // Lint runs once for the domain, not per trial: attribution and coverage both read it.
  const lint = lintDomain(domain);
  results = attributed(domain, tasks, results, lint);
  const summaries: TaskSummary[] = tasks.map((task) => {
    const trials = results.filter((r) => r.taskId === task.id).sort((a, b) => a.trial - b.trial);
    const passes = trials.filter((t) => t.passed).length;
    const graded = trials.filter((t) => !t.skipped).length;
    const interval = wilsonInterval(passes, graded);
    return {
      id: task.id,
      description: task.description,
      tags: task.tags,
      ...(task.critical ? { critical: true as const } : {}),
      trials,
      passes,
      graded,
      skipped: trials.length - graded,
      verdict: verdictOf(passes, graded),
      ...(interval ? { interval } : {}),
      ...taskFingerprints(domain, task, user, prompt),
    };
  });
  const outcomes = summaries.map(gradedOutcomes);
  const passHat: Record<string, number> = {};
  const passAt: Record<string, number> = {};
  for (let j = 1; j <= k; j++) {
    passHat[String(j)] = passHatK(outcomes, j);
    passAt[String(j)] = passAtK(outcomes, j);
  }
  const repeated = summaries.filter((s) => (s.graded ?? 0) >= 2);
  const flaky = summaries.filter((s) => s.verdict === "flaky").map((s) => s.id);
  return {
    tasks: summaries,
    passHat,
    passAt,
    flipRate: repeated.length ? flaky.length / repeated.length : null,
    flaky,
    skipped: summaries.reduce((n, s) => n + (s.skipped ?? 0), 0),
    callerNotes: {
      turns: results.reduce((n, r) => n + (r.callerNotes?.length ?? 0), 0),
      trials: results.filter((r) => r.callerNotes?.length).length,
    },
    attribution: attributionCounts(results),
    failureModes: failureModes(results),
    byTag: tagScores(summaries, k),
    soft: softScores(domain, results),
    coverage: coverageOf(domain, tasks, results, lint, prompt),
  };
}

/**
 * Each trial with its attribution decided under the domain as it is now: a trial that didn't pass gets one, and a
 * trial that passed has none.
 */
function attributed(domain: Domain, tasks: readonly Task[], results: readonly TrialResult[], lint: LintReport): TrialResult[] {
  const lints = new Map(lint.tasks.map((l) => [l.id, l]));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return results.map(({ attribution: _, ...trial }) => {
    const task = byId.get(trial.taskId);
    const attribution = task && attributeTrial(trial, task, lints.get(trial.taskId), domain.invariants);
    return attribution ? { ...trial, attribution } : trial;
  });
}

function verdictOf(passes: number, graded: number): Verdict {
  if (graded === 0) return "skipped";
  return passes === graded ? "passed" : passes === 0 ? "failed" : "flaky";
}

/** Whether each graded trial of a task passed, in trial order: skipped trials are left out. */
export function gradedOutcomes(task: Pick<TaskSummary, "trials">): boolean[] {
  return task.trials.filter((t) => !t.skipped).map((t) => t.passed);
}

/** A trial's status: skipped trials were not graded, so they neither passed nor failed. */
export function trialStatus(trial: Pick<TrialResult, "passed" | "skipped">): "passed" | "failed" | "skipped" {
  return trial.skipped ? "skipped" : trial.passed ? "passed" : "failed";
}

/** The trials that were skipped, in task and trial order. */
export function skippedTrials(result: Pick<SuiteResult, "tasks">): TrialResult[] {
  return result.tasks.flatMap((t) => t.trials.filter((tr) => tr.skipped));
}

/**
 * The critical tasks with at least one failed trial, in spec order. Any one of them fails `sandtable run`,
 * whatever pass^k and `--fail-under` say. A skipped trial isn't a failure: a run with one is incomplete,
 * and `run` fails it for that.
 */
export function criticalFailures(result: Pick<SuiteResult, "tasks">): TaskSummary[] {
  return result.tasks.filter((t) => t.critical && t.passes < (t.graded ?? t.trials.length));
}

/**
 * The tags whose pass^k is below their `--floor`, in the order the floors were given. Any one of them fails
 * `sandtable run`, as `--fail-under` does for the suite. A tag with no task that has k graded trials has no pass^k
 * and is below any floor; the run is then incomplete as well.
 */
export function tagsBelowFloor(result: Pick<SuiteResult, "byTag" | "floors">): Array<TagScore & { floor: number }> {
  return Object.entries(result.floors ?? {}).flatMap(([tag, floor]) => {
    const score = result.byTag.find((t) => t.tag === tag);
    return score && !(score.passHatK >= floor) ? [{ ...score, floor }] : [];
  });
}

/**
 * The first trial's error when every trial ended in an error, else undefined. Such a run graded
 * nothing about the agent: credentials, an optional package or the agent's endpoint were missing.
 */
export function everyTrialFailed(result: SuiteResult): string | undefined {
  const trials = result.tasks.flatMap((t) => t.trials);
  if (trials.length === 0 || !trials.every((t) => t.endReason === "error")) return undefined;
  return trials[0]!.error ?? "unknown error";
}

function softScores(domain: Domain, results: readonly TrialResult[]): SoftScore[] {
  return domain.invariants
    .filter((inv) => inv.soft)
    .map((inv) => {
      const checks = results.flatMap((r) => (r.soft ?? []).filter((c) => c.id === inv.id).map((c) => ({ task: r.taskId, ...c })));
      const broken = checks.filter((c) => c.broken);
      const tool = invariantTool(inv);
      const example = broken[0]?.violations[0]?.detail;
      return {
        id: inv.id,
        description: inv.description,
        ...(tool ? { tool } : {}),
        applied: checks.length,
        broken: broken.length,
        rate: checks.length ? broken.length / checks.length : null,
        tasks: [...new Set(broken.map((c) => c.task))],
        ...(example ? { example } : {}),
      };
    });
}

function tagScores(summaries: TaskSummary[], k: number): TagScore[] {
  const groups = new Map<string, TaskSummary[]>();
  for (const s of summaries) {
    for (const tag of s.tags.length ? s.tags : ["untagged"]) groups.set(tag, [...(groups.get(tag) ?? []), s]);
  }
  return [...groups.entries()]
    .map(([tag, tasks]) => {
      const outcomes = tasks.map(gradedOutcomes);
      return { tag, tasks: tasks.length, passHat1: passHatK(outcomes, 1), passHatK: passHatK(outcomes, k) };
    })
    .sort((a, b) => a.passHat1 - b.passHat1 || a.tag.localeCompare(b.tag));
}

/**
 * Cluster failed checks across trials so the most common failure surfaces first. Skipped trials are left
 * out: their error is not the agent's failure, and reports list them on their own.
 */
function failureModes(results: readonly TrialResult[]): FailureMode[] {
  const modes = new Map<string, FailureMode>();
  for (const r of results) {
    if (r.skipped) continue;
    const seen = new Set<string>();
    for (const c of r.checks) {
      if (c.passed || seen.has(c.id)) continue;
      seen.add(c.id);
      const m = modes.get(c.id) ?? { id: c.id, kind: c.kind, count: 0, tasks: [], example: c.detail };
      m.count++;
      if (!m.tasks.includes(r.taskId)) m.tasks.push(r.taskId);
      modes.set(c.id, m);
    }
  }
  return [...modes.values()].sort((a, b) => b.count - a.count);
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
