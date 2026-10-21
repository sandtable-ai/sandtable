import { criticalFailures, type SoftScore, type SuiteResult } from "../run/suite.ts";
import { totalTokens, type UsageByModel } from "../run/usage.ts";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = paint(32);
const red = paint(31);
const dim = paint(2);
const bold = paint(1);
const yellow = paint(33);

export function formatPercent(x: number): string {
  return Number.isNaN(x) ? "n/a" : `${(x * 100).toFixed(1)}%`;
}

export function formatCost(usd: number | null): string {
  if (usd === null) return "n/a";
  return usd < 0.01 && usd > 0 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

export function formatMs(ms: number | null): string {
  if (ms === null) return "n/a";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// Failure-mode lines fit a classic 80-column terminal. results.json and the HTML report keep the
// full task lists and examples.
const WIDTH = 80;

/** `(a, b, … +N more)`: as many items as fit in `budget` columns, in order, then a count of the rest. */
export function fitList(items: string[], budget: number): string {
  const all = `(${items.join(", ")})`;
  if (all.length <= budget) return all;
  for (let n = items.length - 1; n >= 1; n--) {
    const s = `(${items.slice(0, n).join(", ")}, … +${items.length - n} more)`;
    if (s.length <= budget) return s;
  }
  return `(${items.length} tasks)`;
}

const clip = (s: string, width: number) => (s.length <= width ? s : `${s.slice(0, width - 1)}…`);

function tokens(label: string, group: UsageByModel): string | undefined {
  const t = totalTokens(group);
  if (t.calls === 0) return undefined;
  const models = Object.keys(group).join(", ");
  const stops = t.maxTokensStops ? `, ${t.maxTokensStops} stopped at max_tokens` : "";
  return `${label} ${models}: ${t.calls} calls, ${k(t.input)} in, ${k(t.output)} out, ${k(t.cacheRead)} cache read, ${k(t.cacheWrite)} cache write${stops}`;
}

/** "37.5%  3 of 8 trials that called log_offer", or why there is no rate yet. */
export function softLine(x: SoftScore): string {
  if (x.rate === null) return dim(x.tool ? `no rate: no trial called ${x.tool}` : "no rate: the agent never spoke");
  return `${formatPercent(x.rate).padStart(6)}  ${dim(`${x.broken} of ${x.applied} ${x.tool ? `trials that called ${x.tool}` : "trials"}`)}`;
}

export function renderTerminal(r: SuiteResult): string {
  const lines: string[] = [];
  lines.push(bold(`sandtable · ${r.domain}`) + dim(` · agent ${r.agent} · user ${r.user} · k=${r.k}`));
  if (r.pendingReview?.length) {
    lines.push(yellow(`  ⚠ ${r.pendingReview.length} drafted item(s) pending review: results are provisional (npx sandtable-ai review <domain>)`));
  }
  lines.push("");
  const width = Math.max(4, ...r.tasks.map((t) => t.id.length));
  const fracWidth = Math.max(...r.tasks.map((t) => `${t.passes}/${t.trials.length}`.length));
  lines.push(dim(`  ${"task".padEnd(width)}  trials${" ".repeat(Math.max(0, r.k - 6))}  pass`));
  // Critical tasks first, each marked, then the rest; both in spec order.
  const critical = r.tasks.filter((t) => t.critical);
  for (const t of [...critical, ...r.tasks.filter((t) => !t.critical)]) {
    const marks = t.trials.map((tr) => (tr.passed ? green("✓") : red("✗"))).join("");
    const pad = " ".repeat(Math.max(0, 6 - t.trials.length));
    const frac = `${t.passes}/${t.trials.length}`;
    const allPassed = t.passes === t.trials.length;
    const label = t.critical ? `${" ".repeat(fracWidth - frac.length)}  ${allPassed ? dim("critical") : red("critical")}` : "";
    lines.push(`  ${t.id.padEnd(width)}  ${marks}${pad}  ${allPassed ? green(frac) : red(frac)}${label}`);
  }
  lines.push("");
  const hats = Object.entries(r.passHat)
    .filter(([j]) => j === "1" || j === String(r.k))
    .map(([j, v]) => `${bold(`pass^${j}`)} ${formatPercent(v)}`);
  lines.push(`  ${hats.join("   ")}`);
  if (critical.length) {
    const passed = critical.length - criticalFailures(r).length;
    const line = `${passed} of ${critical.length} passed every trial`;
    lines.push(`  ${bold("critical")} ${passed === critical.length ? green(line) : red(line)}`);
  }
  lines.push(dim(`  agent turn latency p50 ${formatMs(r.latency.agentTurnP50Ms)} · p95 ${formatMs(r.latency.agentTurnP95Ms)}`));
  const usageLines = [tokens("agent", r.usage.agent), tokens("user", r.usage.user)].filter(Boolean);
  if (usageLines.length) {
    lines.push(dim(`  estimated cost ${formatCost(r.usage.costUsd)}`));
    for (const l of usageLines) lines.push(dim(`    ${l}`));
  }

  if (r.byTag.length > 1) {
    lines.push("");
    lines.push(bold("  By tag"));
    const tw = Math.max(...r.byTag.map((t) => t.tag.length));
    for (const t of r.byTag) {
      const kCol = r.k > 1 ? `   pass^${r.k} ${formatPercent(t.passHatK).padStart(6)}` : "";
      lines.push(`  ${t.tag.padEnd(tw)}  ${dim(`${t.tasks} task${t.tasks === 1 ? "" : "s"}`.padEnd(8))}  pass^1 ${formatPercent(t.passHat1).padStart(6)}${kCol}`);
    }
  }

  const soft = r.soft ?? [];
  if (soft.length) {
    lines.push("");
    lines.push(bold("  Soft rules") + dim(" (reported, never fail a trial)"));
    const sw = Math.max(...soft.map((x) => x.id.length));
    for (const x of soft) lines.push(`  ${x.id.padEnd(sw)}  ${softLine(x)}`);
  }

  if (r.failureModes.length) {
    lines.push("");
    lines.push(bold("  Top failure modes"));
    for (const m of r.failureModes.slice(0, 8)) {
      const head = `  ${m.count}× ${m.kind} ${m.id} `;
      lines.push(`  ${red(`${m.count}×`)} ${m.kind} ${bold(m.id)} ${dim(fitList(m.tasks, WIDTH - head.length))}`);
      lines.push(dim(clip(`     e.g. ${m.example}`, WIDTH)));
    }
  }
  return lines.join("\n");
}
