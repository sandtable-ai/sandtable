import type { CheckKind } from "../grade/expectations.ts";
import { passHatK } from "../grade/passk.ts";
import type { Domain } from "../spec/schema.ts";
import type { AgentAdapter, UserSimulator } from "../sim/types.ts";
import { runEpisode, type TrialResult } from "./episode.ts";

export interface TaskSummary {
  id: string;
  description?: string;
  tags: string[];
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

export interface SuiteResult {
  version: 1;
  domain: string;
  agent: string;
  user: string;
  k: number;
  startedAt: string;
  durationMs: number;
  tasks: TaskSummary[];
  /** pass^1 .. pass^k */
  passHat: Record<string, number>;
  failureModes: FailureMode[];
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
  const started = performance.now();

  const tasks = opts.taskIds?.length ? domain.tasks.filter((t) => opts.taskIds!.includes(t.id)) : domain.tasks;
  const missing = (opts.taskIds ?? []).filter((id) => !domain.tasks.some((t) => t.id === id));
  if (missing.length) throw new Error(`unknown task id(s): ${missing.join(", ")}`);

  const jobs = tasks.flatMap((task) => Array.from({ length: k }, (_, trial) => ({ task, trial })));
  const results = await pool(jobs, opts.concurrency ?? 4, async ({ task, trial }) => {
    const r = await runEpisode({ domain, task, agent, user, trial });
    opts.onTrial?.(r);
    return r;
  });

  const summaries: TaskSummary[] = tasks.map((task) => {
    const trials = results.filter((r) => r.taskId === task.id).sort((a, b) => a.trial - b.trial);
    return { id: task.id, description: task.description, tags: task.tags, trials, passes: trials.filter((t) => t.passed).length };
  });

  const outcomes = summaries.map((s) => s.trials.map((t) => t.passed));
  const passHat: Record<string, number> = {};
  for (let j = 1; j <= k; j++) passHat[String(j)] = passHatK(outcomes, j);

  return {
    version: 1,
    domain: domain.name,
    agent: agent.name,
    user: user.name,
    k,
    startedAt,
    durationMs: Math.round(performance.now() - started),
    tasks: summaries,
    passHat,
    failureModes: failureModes(results),
  };
}

/** Cluster failed checks across trials so the most common failure surfaces first. */
function failureModes(results: TrialResult[]): FailureMode[] {
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
