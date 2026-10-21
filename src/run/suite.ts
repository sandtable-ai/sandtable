import type { CheckKind } from "../grade/expectations.ts";
import { invariantTool } from "../grade/invariants.ts";
import { passHatK } from "../grade/passk.ts";
import { pendingReview, type PendingItem } from "../spec/load.ts";
import type { Domain, Task } from "../spec/schema.ts";
import type { AgentAdapter, UserSimulator } from "../sim/types.ts";
import { runEpisode, type TrialResult } from "./episode.ts";
import { inputsFingerprint } from "./inputs.ts";
import { percentile, sumUsage, type Usage } from "./usage.ts";

export interface TaskSummary {
  id: string;
  description?: string;
  tags: string[];
  /** Set only on a critical task: any failed trial fails `sandtable run`. */
  critical?: true;
  trials: TrialResult[];
  passes: number;
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
  /** Unique per run; prefixes agent session ids (`<runId>/<task-id>#<trial>`). */
  runId: string;
  domain: string;
  agent: string;
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
  /** pass^1 .. pass^k */
  passHat: Record<string, number>;
  failureModes: FailureMode[];
  /** pass^1 and pass^k per task tag ("untagged" for tasks without tags). */
  byTag: TagScore[];
  /** One entry per soft invariant in the domain, in spec order. Empty when there are none. */
  soft: SoftScore[];
  usage: Usage;
  /** Drafted items not yet accepted; while non-empty, results are provisional. */
  pendingReview: PendingItem[];
  /** Time the agent took to answer each user turn, tool calls included. */
  latency: { agentTurnP50Ms: number | null; agentTurnP95Ms: number | null };
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
}

export async function runSuite(opts: SuiteOptions): Promise<SuiteResult> {
  const { domain, agent, user } = opts;
  const k = opts.k ?? 1;
  const startedAt = new Date().toISOString();
  // e.g. 20261018T210512-k3f9: sortable and unique per run, used to namespace agent session ids.
  const runId = `${startedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "")}-${Math.random().toString(36).slice(2, 6)}`;
  const started = performance.now();

  const tasks = opts.taskIds?.length ? domain.tasks.filter((t) => opts.taskIds!.includes(t.id)) : domain.tasks;
  const missing = (opts.taskIds ?? []).filter((id) => !domain.tasks.some((t) => t.id === id));
  if (missing.length) throw new Error(`unknown task id(s): ${missing.join(", ")}`);

  const jobs = tasks.flatMap((task) => Array.from({ length: k }, (_, trial) => ({ task, trial })));
  const results = await pool(jobs, opts.concurrency ?? 4, async ({ task, trial }) => {
    const r = await runEpisode({ domain, task, agent, user, trial, runId });
    opts.onTrial?.(r);
    return r;
  });

  const turnLatencies = results.flatMap((r) => r.events.flatMap((e) => (e.type === "agent" ? [e.latencyMs] : [])));

  return {
    version: 1,
    runId,
    domain: domain.name,
    agent: agent.name,
    user: user.name,
    k,
    inputs: inputsFingerprint(domain, tasks.map((t) => t.id), user.name),
    startedAt,
    durationMs: Math.round(performance.now() - started),
    ...summarize(domain, tasks, results, k),
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
): Pick<SuiteResult, "tasks" | "passHat" | "failureModes" | "byTag" | "soft"> {
  const summaries: TaskSummary[] = tasks.map((task) => {
    const trials = results.filter((r) => r.taskId === task.id).sort((a, b) => a.trial - b.trial);
    return {
      id: task.id,
      description: task.description,
      tags: task.tags,
      ...(task.critical ? { critical: true as const } : {}),
      trials,
      passes: trials.filter((t) => t.passed).length,
    };
  });
  const outcomes = summaries.map((s) => s.trials.map((t) => t.passed));
  const passHat: Record<string, number> = {};
  for (let j = 1; j <= k; j++) passHat[String(j)] = passHatK(outcomes, j);
  return {
    tasks: summaries,
    passHat,
    failureModes: failureModes(results),
    byTag: tagScores(summaries, k),
    soft: softScores(domain, results),
  };
}

/**
 * The critical tasks with at least one failed trial, in spec order. Any one of them fails `sandtable run`,
 * whatever pass^k and `--fail-under` say.
 */
export function criticalFailures(result: Pick<SuiteResult, "tasks">): TaskSummary[] {
  return result.tasks.filter((t) => t.critical && t.passes < t.trials.length);
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
      const outcomes = tasks.map((t) => t.trials.map((tr) => tr.passed));
      return { tag, tasks: tasks.length, passHat1: passHatK(outcomes, 1), passHatK: passHatK(outcomes, k) };
    })
    .sort((a, b) => a.passHat1 - b.passHat1 || a.tag.localeCompare(b.tag));
}

/** Cluster failed checks across trials so the most common failure surfaces first. */
function failureModes(results: readonly TrialResult[]): FailureMode[] {
  const modes = new Map<string, FailureMode>();
  for (const r of results) {
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
