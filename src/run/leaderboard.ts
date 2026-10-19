import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { renderHtml } from "../report/html.ts";
import type { Domain } from "../spec/schema.ts";
import { noopAgent } from "../sim/noop.ts";
import { scriptedUser } from "../sim/scripted.ts";
import type { AgentAdapter, UserSimulator } from "../sim/types.ts";
import { runSuite, type SuiteResult } from "./suite.ts";
import { costOf, totalTokens } from "./usage.ts";

/** The models file `sandtable leaderboard -m <file>` reads. */
export const ModelsFile = z
  .object({
    user: z.string().optional(),
    k: z.number().int().positive().optional(),
    models: z.array(z.object({ label: z.string(), agent: z.string() }).strict()).min(1),
  })
  .strict();

export interface LeaderboardEntry {
  /** Display name, e.g. "Claude Opus 5.5". */
  label: string;
  /** Agent spec as accepted by `sandtable run --agent`, e.g. claude:claude-opus-5-5 or bedrock:global.openai.gpt-5.5. */
  agent: string;
}

export interface LeaderboardRow {
  label: string;
  agent: string;
  baseline: boolean;
  passHat1: number;
  passHatK: number;
  tasks: number;
  trials: number;
  /** Failed trials per broken invariant. */
  violations: Record<string, number>;
  /** Most common failed check across trials. */
  topFailure?: string;
  /** Agent and simulated caller together. */
  costUsd: number | null;
  costPerTrialUsd: number | null;
  /** The agent's model only: what the Cost / trial column shows. */
  agentCostPerTrialUsd: number | null;
  agentTurnP95Ms: number | null;
  agentTokens: number;
  error?: string;
}

export interface LeaderboardResult {
  version: 1;
  domain: string;
  user: string;
  k: number;
  generatedAt: string;
  rows: LeaderboardRow[];
}

export interface LeaderboardOptions {
  domain: Domain;
  entries: LeaderboardEntry[];
  user: UserSimulator;
  k: number;
  outDir: string;
  resolveAgent: (spec: string) => Promise<AgentAdapter>;
  concurrency?: number;
  /** Run only these tasks, for every model and the baseline. Default: all. */
  taskIds?: string[];
  /** Reuse an entry's results.json when it exists and matches this run (default true). */
  resume?: boolean;
  /** `note` says why stored results were not reused, or why an entry was skipped. */
  onEntry?: (label: string, status: "cached" | "ran" | "failed" | "skipped", note?: string) => void;
}

export function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "model";
}

async function exists(p: string): Promise<boolean> {
  return (await stat(p).catch(() => undefined)) !== undefined;
}

/**
 * Why stored results cannot stand in for this run, or undefined when they can. Results are
 * comparable only under the same domain, k, simulated caller and tasks, and a crashed trial
 * (throttling, expired credentials) is not a result.
 */
export function staleReason(r: SuiteResult, want: { domain: string; k: number; user: string; taskIds: string[] }): string | undefined {
  if (r.domain !== want.domain) return `they are for domain ${r.domain}, not ${want.domain}`;
  if (r.k !== want.k) return `they are for k=${r.k}, not k=${want.k}`;
  if (r.user !== want.user) return `the caller was ${r.user}, not ${want.user}`;
  const had = r.tasks.map((t) => t.id).sort();
  const want_ = [...want.taskIds].sort();
  if (had.length !== want_.length || had.some((id, i) => id !== want_[i])) return "they cover different tasks";
  const crashed = r.tasks.reduce((n, t) => n + t.trials.filter((tr) => tr.endReason === "error").length, 0);
  if (crashed) return `${crashed} trial(s) crashed`;
  return undefined;
}

function errorRow(entry: LeaderboardEntry, error: string): LeaderboardRow {
  return {
    label: entry.label,
    agent: entry.agent,
    baseline: false,
    passHat1: Number.NaN,
    passHatK: Number.NaN,
    tasks: 0,
    trials: 0,
    violations: {},
    costUsd: null,
    costPerTrialUsd: null,
    agentCostPerTrialUsd: null,
    agentTurnP95Ms: null,
    agentTokens: 0,
    error,
  };
}

export function toRow(entry: LeaderboardEntry, r: SuiteResult, baseline = false): LeaderboardRow {
  const violations: Record<string, number> = {};
  for (const m of r.failureModes) if (m.kind === "invariant") violations[m.id] = m.count;
  const trials = r.tasks.reduce((n, t) => n + t.trials.length, 0);
  const cost = r.usage.costUsd;
  const hasUsage = totalTokens(r.usage.agent).calls + totalTokens(r.usage.user).calls > 0;
  return {
    label: entry.label,
    agent: entry.agent,
    baseline,
    passHat1: r.passHat["1"] ?? Number.NaN,
    passHatK: r.passHat[String(r.k)] ?? Number.NaN,
    tasks: r.tasks.length,
    trials,
    violations,
    ...(r.failureModes[0] ? { topFailure: `${r.failureModes[0].id} (${r.failureModes[0].count}×)` } : {}),
    costUsd: hasUsage ? cost : null,
    costPerTrialUsd: hasUsage && cost !== null && trials ? cost / trials : null,
    agentCostPerTrialUsd: (() => {
      const agentCost = totalTokens(r.usage.agent).calls > 0 ? costOf(r.usage.agent) : null;
      return agentCost !== null && trials ? agentCost / trials : null;
    })(),
    agentTurnP95Ms: r.latency.agentTurnP95Ms,
    agentTokens: (() => {
      const t = totalTokens(r.usage.agent);
      return t.input + t.output + t.cacheRead + t.cacheWrite;
    })(),
  };
}

/**
 * Run several agents on one domain under the same simulated users, plus a do-nothing
 * baseline, and rank them by pass^k. Each entry's full results are kept next to the
 * leaderboard so every number can be traced to its trajectories.
 */
export async function runLeaderboard(opts: LeaderboardOptions): Promise<LeaderboardResult> {
  const { domain, entries, user, k, outDir } = opts;
  const unknown = (opts.taskIds ?? []).filter((id) => !domain.tasks.some((t) => t.id === id));
  if (unknown.length) throw new Error(`unknown task id(s): ${unknown.join(", ")}`);
  const tasks = opts.taskIds?.length ? domain.tasks.filter((t) => opts.taskIds!.includes(t.id)) : domain.tasks;
  const taskIds = tasks.map((t) => t.id);
  await mkdir(outDir, { recursive: true });
  const rows: LeaderboardRow[] = [];

  for (const entry of entries) {
    if (entry.agent === "noop") {
      opts.onEntry?.(entry.label, "skipped", "the do-nothing baseline is always included");
      continue;
    }
    const dir = path.join(outDir, slugify(entry.label));
    const file = path.join(dir, "results.json");
    let result: SuiteResult | undefined;
    let stale: string | undefined;
    let fresh = false;
    if ((opts.resume ?? true) && (await exists(file))) {
      const stored = JSON.parse(await readFile(file, "utf8")) as SuiteResult;
      stale = staleReason(stored, { domain: domain.name, k, user: user.name, taskIds });
      if (!stale) {
        result = stored;
        opts.onEntry?.(entry.label, "cached");
      }
    }
    if (!result) {
      try {
        const agent = await opts.resolveAgent(entry.agent);
        result = await runSuite({ domain, agent, user, k, taskIds, concurrency: opts.concurrency ?? 4 });
        await mkdir(dir, { recursive: true });
        await writeFile(file, JSON.stringify(result, null, 2));
        await writeFile(path.join(dir, "report.html"), renderHtml(result));
        fresh = true;
      } catch (err) {
        opts.onEntry?.(entry.label, "failed");
        rows.push(errorRow(entry, err instanceof Error ? err.message : String(err)));
        continue;
      }
    }
    // A crashed trial (credentials, throttling) says nothing about the model: show the row as an
    // error instead of ranking it. Its results stay on disk, and the next run retries the model.
    const crashes = result.tasks.flatMap((t) => t.trials.filter((tr) => tr.endReason === "error"));
    if (crashes.length) {
      const trials = result.tasks.reduce((n, t) => n + t.trials.length, 0);
      const message = `${crashes.length} of ${trials} trial(s) crashed: ${crashes[0]!.error ?? "unknown error"}`;
      opts.onEntry?.(entry.label, "failed", message);
      rows.push(errorRow(entry, message));
      continue;
    }
    if (fresh) opts.onEntry?.(entry.label, "ran", stale && `stored results not reused: ${stale}`);
    rows.push(toRow(entry, result));
  }

  // Do-nothing baseline: the share of the suite that rewards inaction. Scripted users keep it free
  // when every task has a script; otherwise it runs under the same simulated user as the models.
  const scripted = tasks.every((t) => t.user.script?.length);
  const noop = await runSuite({ domain, agent: noopAgent(), user: scripted ? scriptedUser() : user, k: scripted ? 1 : k, taskIds });
  const baseline = toRow({ label: "Do-nothing baseline", agent: "noop" }, noop, true);
  // A scripted noop run is deterministic, so its pass^k equals its pass^1.
  if (scripted) baseline.passHatK = baseline.passHat1;
  rows.push(baseline);

  // Errored rows (NaN) sort last; a 0% model still ranks above them.
  const score = (x: number) => (Number.isNaN(x) ? -1 : x);
  rows.sort((a, b) => score(b.passHatK) - score(a.passHatK) || score(b.passHat1) - score(a.passHat1));
  const result: LeaderboardResult = { version: 1, domain: domain.name, user: user.name, k, generatedAt: new Date().toISOString(), rows };
  await writeFile(path.join(outDir, "leaderboard.json"), JSON.stringify(result, null, 2));
  await writeFile(path.join(outDir, "LEADERBOARD.md"), renderLeaderboardMarkdown(result));
  await writeFile(path.join(outDir, "leaderboard.html"), renderLeaderboardHtml(result));
  return result;
}

const pct = (x: number) => (Number.isNaN(x) ? "n/a" : `${(x * 100).toFixed(1)}%`);
const usd = (x: number | null) => (x === null ? "n/a" : x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(3)}`);
const secs = (ms: number | null) => (ms === null ? "n/a" : `${(ms / 1000).toFixed(1)}s`);
const totalViolations = (r: LeaderboardRow) => Object.values(r.violations).reduce((a, b) => a + b, 0);
/** pass^1, plus pass^k when k > 1. */
const passHeads = (k: number) => (k === 1 ? ["pass^1"] : ["pass^1", `pass^${k}`]);
const passCells = (r: LeaderboardRow, k: number) => (k === 1 ? [pct(r.passHat1)] : [pct(r.passHat1), pct(r.passHatK)]);
const howOften = (k: number) => (k === 1 ? "once" : `${k} times`);
const passMeaning = (k: number) => (k === 1 ? "pass^1 is the share of tasks that passed." : `pass^${k} is the share of tasks where all ${k} trials passed.`);
const COST_NOTE = "Cost / trial counts the agent's model only; leaderboard.json also has the cost with the simulated caller.";

export function renderLeaderboardMarkdown(l: LeaderboardResult): string {
  const heads = ["#", "Model", ...passHeads(l.k), "Rule violations", "Top failure", "Cost / trial", "p95 turn"];
  const lines = [
    `# Leaderboard: ${l.domain}`,
    "",
    `Each model plays the agent on every task ${howOften(l.k)}, against the same simulated callers (${l.user}). ${passMeaning(l.k)} Grading is deterministic: end state, rules checked on every tool call and message, required and forbidden tools. ${COST_NOTE}`,
    "",
    `| ${heads.join(" | ")} |`,
    `|${heads.map(() => "---").join("|")}|`,
  ];
  let rank = 0;
  for (const r of l.rows) {
    const place = r.baseline || r.error ? "" : String(++rank);
    const model = r.baseline ? `_${r.label}_` : r.label;
    const cells = r.error
      ? [place, model, "error", ...passHeads(l.k).slice(1).map(() => ""), "", r.error.replace(/\|/g, "/").slice(0, 80), "", ""]
      : [place, model, ...passCells(r, l.k), String(totalViolations(r)), r.topFailure ?? "", usd(r.agentCostPerTrialUsd), secs(r.agentTurnP95Ms)];
    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push("", `Generated ${l.generatedAt} with [sandtable](https://github.com/sandtable-ai/sandtable). Per-model reports and trajectories are in the folders next to this file.`, "");
  return lines.join("\n");
}

export function renderLeaderboardHtml(l: LeaderboardResult): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const body = l.rows
    .map((r) => {
      const link = r.baseline ? esc(r.label) : `<a href="./${slugify(r.label)}/report.html">${esc(r.label)}</a>`;
      if (r.error) return `<tr><td>${link}</td><td colspan="${passHeads(l.k).length + 4}" class="err">${esc(r.error)}</td></tr>`;
      const pass = passCells(r, l.k).map((c, i, all) => (i === all.length - 1 ? `<td><b>${c}</b></td>` : `<td>${c}</td>`)).join("");
      return `<tr${r.baseline ? ' class="base"' : ""}><td>${link}</td>${pass}<td>${totalViolations(r)}</td><td>${esc(r.topFailure ?? "")}</td><td>${usd(r.agentCostPerTrialUsd)}</td><td>${secs(r.agentTurnP95Ms)}</td></tr>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Leaderboard · ${esc(l.domain)}</title>
<style>
:root{--bg:#fbfaf8;--fg:#1d1d1b;--muted:#6b6a66;--card:#fff;--line:#e6e3dd;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe7;--muted:#9c9a94;--card:#1d1d1b;--line:#33322f;--bad:#ff6b5e}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1040px;margin:0 auto;padding:32px 16px 64px}h1{font-size:22px;margin:0 0 6px}
p{color:var(--muted);max-width:780px}.wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line)}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
th{font-size:12px;color:var(--muted)}tr.base td{color:var(--muted);font-style:italic}.err{color:var(--bad)}a{color:inherit}
</style></head><body><main>
<h1>Leaderboard: ${esc(l.domain)}</h1>
<p>Each model plays the agent on every task ${howOften(l.k)} against the same simulated callers (${esc(l.user)}). ${passMeaning(l.k).replace(/^(pass\^\d+)/, "<b>$1</b>")} Grading is deterministic: end state, rules checked on every tool call and message, required and forbidden tools. ${COST_NOTE} Click a model for its full report and trajectories.</p>
<div class="wrap"><table><thead><tr><th>Model</th>${passHeads(l.k).map((h) => `<th>${h}</th>`).join("")}<th>Rule violations</th><th>Top failure</th><th>Cost / trial</th><th>p95 turn</th></tr></thead>
<tbody>
${body}
</tbody></table></div>
<p>Generated ${esc(l.generatedAt)} with <a href="https://github.com/sandtable-ai/sandtable">sandtable</a>.</p>
</main></body></html>
`;
}
