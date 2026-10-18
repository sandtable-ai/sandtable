import type { CheckKind } from "../grade/expectations.ts";
import { passHatK } from "../grade/passk.ts";
import type { Domain } from "../spec/schema.ts";
import type { AgentAdapter, UserSimulator } from "../sim/types.ts";
import { runEpisode, type TrialResult } from "./episode.ts";
import { percentile, sumUsage, type Usage } from "./usage.ts";

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
  /** pass^1 and pass^k per task tag ("untagged" for tasks without tags). */
  byTag: TagScore[];
  usage: Usage;
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

  const turnLatencies = results.flatMap((r) => r.events.flatMap((e) => (e.type === "agent" ? [e.latencyMs] : [])));
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
    byTag: tagScores(summaries, k),
    usage: sumUsage(results.map((r) => r.usage)),
    latency: { agentTurnP50Ms: percentile(turnLatencies, 50), agentTurnP95Ms: percentile(turnLatencies, 95) },
  };
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
