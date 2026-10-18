import type { SuiteResult } from "../run/suite.ts";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = paint(32);
const red = paint(31);
const dim = paint(2);
const bold = paint(1);

export function formatPercent(x: number): string {
  return Number.isNaN(x) ? "n/a" : `${(x * 100).toFixed(1)}%`;
}

export function renderTerminal(r: SuiteResult): string {
  const lines: string[] = [];
  lines.push(bold(`rehearse · ${r.domain}`) + dim(` · agent ${r.agent} · user ${r.user} · k=${r.k}`));
  lines.push("");
  const width = Math.max(4, ...r.tasks.map((t) => t.id.length));
  lines.push(dim(`  ${"task".padEnd(width)}  trials${" ".repeat(Math.max(0, r.k - 6))}  pass`));
  for (const t of r.tasks) {
    const marks = t.trials.map((tr) => (tr.passed ? green("✓") : red("✗"))).join("");
    const pad = " ".repeat(Math.max(0, 6 - t.trials.length));
    const frac = `${t.passes}/${t.trials.length}`;
    lines.push(`  ${t.id.padEnd(width)}  ${marks}${pad}  ${t.passes === t.trials.length ? green(frac) : red(frac)}`);
  }
  lines.push("");
  const hats = Object.entries(r.passHat)
    .filter(([j]) => j === "1" || j === String(r.k))
    .map(([j, v]) => `${bold(`pass^${j}`)} ${formatPercent(v)}`);
  lines.push(`  ${hats.join("   ")}`);

  if (r.failureModes.length) {
    lines.push("");
    lines.push(bold("  Top failure modes"));
    for (const m of r.failureModes.slice(0, 8)) {
      lines.push(`  ${red(`${m.count}×`)} ${m.kind} ${bold(m.id)} ${dim(`(${m.tasks.join(", ")})`)}`);
      lines.push(dim(`     e.g. ${m.example}`));
    }
  }
  return lines.join("\n");
}
