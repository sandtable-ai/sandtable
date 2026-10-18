import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderHtml } from "../report/html.ts";
import type { Domain } from "../spec/schema.ts";
import { noopAgent } from "../sim/noop.ts";
import { scriptedUser } from "../sim/scripted.ts";
import type { AgentAdapter, UserSimulator } from "../sim/types.ts";
import { runSuite, type SuiteResult } from "./suite.ts";
import { totalTokens } from "./usage.ts";

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
  costUsd: number | null;
  costPerTrialUsd: number | null;
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
  /** Reuse an entry's results.json when it already exists (default true). */
  resume?: boolean;
  onEntry?: (label: string, status: "cached" | "ran" | "failed") => void;
}

export function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "model";
}

async function exists(p: string): Promise<boolean> {
  return (await stat(p).catch(() => undefined)) !== undefined;
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
  await mkdir(outDir, { recursive: true });
  const rows: LeaderboardRow[] = [];

  for (const entry of entries) {
    const dir = path.join(outDir, slugify(entry.label));
    const file = path.join(dir, "results.json");
    let result: SuiteResult | undefined;
    if ((opts.resume ?? true) && (await exists(file))) {
      result = JSON.parse(await readFile(file, "utf8")) as SuiteResult;
      opts.onEntry?.(entry.label, "cached");
    } else {
      try {
        const agent = await opts.resolveAgent(entry.agent);
        result = await runSuite({ domain, agent, user, k, concurrency: opts.concurrency ?? 4 });
        await mkdir(dir, { recursive: true });
        await writeFile(file, JSON.stringify(result, null, 2));
        await writeFile(path.join(dir, "report.html"), renderHtml(result));
        opts.onEntry?.(entry.label, "ran");
      } catch (err) {
        opts.onEntry?.(entry.label, "failed");
        rows.push({
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
          agentTurnP95Ms: null,
          agentTokens: 0,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    }
    rows.push(toRow(entry, result));
  }

  // Do-nothing baseline: the share of the suite that rewards inaction. Scripted users keep it free
  // when every task has a script; otherwise it runs under the same simulated user as the models.
  const scripted = domain.tasks.every((t) => t.user.script?.length);
  const noop = await runSuite({ domain, agent: noopAgent(), user: scripted ? scriptedUser() : user, k: scripted ? 1 : k });
  const baseline = toRow({ label: "Do-nothing baseline", agent: "noop" }, noop, true);
  // A scripted noop run is deterministic, so its pass^k equals its pass^1.
  if (scripted) baseline.passHatK = baseline.passHat1;
  rows.push(baseline);

  rows.sort((a, b) => (b.passHatK || -1) - (a.passHatK || -1) || (b.passHat1 || -1) - (a.passHat1 || -1));
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

export function renderLeaderboardMarkdown(l: LeaderboardResult): string {
  const lines = [
    `# Leaderboard: ${l.domain}`,
    "",
    `Each model plays the agent on every task ${l.k} times, against the same simulated callers (${l.user}). pass^${l.k} is the share of tasks where all ${l.k} trials passed. Grading is deterministic: end state, rules checked on every tool call and message, required and forbidden tools.`,
    "",
    `| # | Model | pass^1 | pass^${l.k} | Rule violations | Top failure | Cost / trial | p95 turn |`,
    "|---|---|---|---|---|---|---|---|",
  ];
  let rank = 0;
  for (const r of l.rows) {
    const place = r.baseline || r.error ? "" : String(++rank);
    const model = r.baseline ? `_${r.label}_` : r.label;
    if (r.error) {
      lines.push(`| ${place} | ${model} | error | | | ${r.error.replace(/\|/g, "/").slice(0, 80)} | | |`);
      continue;
    }
    lines.push(
      `| ${place} | ${model} | ${pct(r.passHat1)} | ${pct(r.passHatK)} | ${totalViolations(r)} | ${r.topFailure ?? ""} | ${usd(r.costPerTrialUsd)} | ${secs(r.agentTurnP95Ms)} |`,
    );
  }
  lines.push("", `Generated ${l.generatedAt} with [sandtable](https://github.com/sandtable-ai/sandtable). Per-model reports and trajectories are in the folders next to this file.`, "");
  return lines.join("\n");
}

export function renderLeaderboardHtml(l: LeaderboardResult): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const body = l.rows
    .map((r) => {
      const link = r.baseline ? esc(r.label) : `<a href="./${slugify(r.label)}/report.html">${esc(r.label)}</a>`;
      if (r.error) return `<tr><td>${link}</td><td colspan="6" class="err">${esc(r.error)}</td></tr>`;
      return `<tr${r.baseline ? ' class="base"' : ""}><td>${link}</td><td>${pct(r.passHat1)}</td><td><b>${pct(r.passHatK)}</b></td><td>${totalViolations(r)}</td><td>${esc(r.topFailure ?? "")}</td><td>${usd(r.costPerTrialUsd)}</td><td>${secs(r.agentTurnP95Ms)}</td></tr>`;
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
<p>Each model plays the agent on every task ${l.k} times against the same simulated callers (${esc(l.user)}). <b>pass^${l.k}</b> is the share of tasks where all ${l.k} trials passed. Grading is deterministic: end state, rules checked on every tool call and message, required and forbidden tools. Click a model for its full report and trajectories.</p>
<div class="wrap"><table><thead><tr><th>Model</th><th>pass^1</th><th>pass^${l.k}</th><th>Rule violations</th><th>Top failure</th><th>Cost / trial</th><th>p95 turn</th></tr></thead>
<tbody>
${body}
</tbody></table></div>
<p>Generated ${esc(l.generatedAt)} with <a href="https://github.com/sandtable-ai/sandtable">sandtable</a>.</p>
</main></body></html>
`;
}
