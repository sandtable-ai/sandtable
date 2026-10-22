import { comparisonOf, type Comparison, type TaskChange } from "../run/compare.ts";
import { gradedOutcomes, skippedTrials, trialStatus, type SoftScore, type SuiteResult, type TaskSummary } from "../run/suite.ts";
import { costOf, totalTokens, type UsageByModel } from "../run/usage.ts";

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

/** "<label> <models>: N calls, 12.3k in, 4.1k out, ..." for a group of model calls, or undefined when there were none. */
export function tokenLine(label: string, group: UsageByModel): string | undefined {
  const t = totalTokens(group);
  if (t.calls === 0) return undefined;
  const models = Object.keys(group).join(", ");
  const stops = t.maxTokensStops ? `, ${t.maxTokensStops} stopped at max_tokens` : "";
  const reasoning = t.reasoningStripped ? `, ${t.reasoningStripped} with reasoning removed` : "";
  const silent = t.emptyAfterStrip ? `, ${t.emptyAfterStrip} silent once it was removed` : "";
  return `${label} ${models}: ${t.calls} calls, ${k(t.input)} in, ${k(t.output)} out, ${k(t.cacheRead)} cache read, ${k(t.cacheWrite)} cache write${stops}${reasoning}${silent}`;
}

/**
 * What an `init` drafting step's model calls used and cost, in the lines `run` prints: the estimated cost at list
 * prices, then the token line. Empty when no call reported usage.
 */
export function draftUsageLines(usage: UsageByModel): string[] {
  const line = tokenLine("model", usage);
  return line ? [`  estimated cost ${formatCost(costOf(usage))}`, `    ${line}`] : [];
}

/** "37.5%  3 of 8 trials that called log_offer", or why there is no rate yet. */
export function softLine(x: SoftScore): string {
  if (x.rate === null) return dim(x.tool ? `no rate: no trial called ${x.tool}` : "no rate: the agent never spoke");
  return `${formatPercent(x.rate).padStart(6)}  ${dim(`${x.broken} of ${x.applied} ${x.tool ? `trials that called ${x.tool}` : "trials"}`)}`;
}

/** "30%–95%": a 95% interval, in whole percent. */
export function formatInterval(i: { low: number; high: number }): string {
  return `${Math.round(i.low * 100)}%–${Math.round(i.high * 100)}%`;
}

const MARK = { passed: green("✓"), failed: red("✗"), skipped: dim("○") } as const;

/** Graded trials of a task; results from before verdicts have no count, and every trial was graded. */
const gradedOf = (t: TaskSummary) => t.graded ?? t.trials.length;

/** What a task's row adds after passes/graded: a flaky or skipped verdict, or how many trials were skipped. */
function taskNote(t: TaskSummary): string {
  if (t.verdict === "skipped") return dim("skipped");
  const skipped = t.skipped ? `${t.skipped} skipped` : "";
  if (t.verdict === "flaky") return skipped ? `${yellow("flaky")}${dim(`, ${skipped}`)}` : yellow("flaky");
  return dim(skipped);
}

/**
 * The run's summary. A run compared with a baseline ends with what changed since; `baseline` names the
 * file it came from (else the block names the baseline's run id).
 */
export function renderTerminal(r: SuiteResult, opts: { baseline?: string } = {}): string {
  const lines: string[] = [];
  lines.push(bold(`sandtable · ${r.domain}`) + dim(` · agent ${r.agent} · user ${r.user} · k=${r.k}`));
  if (r.pendingReview?.length) {
    lines.push(yellow(`  ⚠ ${r.pendingReview.length} drafted item(s) pending review: results are provisional (npx sandtable-ai review <domain>)`));
  }
  lines.push("");
  const width = Math.max(4, ...r.tasks.map((t) => t.id.length));
  const fracWidth = Math.max(...r.tasks.map((t) => `${t.passes}/${gradedOf(t)}`.length));
  lines.push(dim(`  ${"task".padEnd(width)}  trials${" ".repeat(Math.max(0, r.k - 6))}  pass`));
  // Critical tasks first, each marked, then the rest; both in spec order.
  const critical = r.tasks.filter((t) => t.critical);
  for (const t of [...critical, ...r.tasks.filter((t) => !t.critical)]) {
    const marks = t.trials.map((tr) => MARK[trialStatus(tr)]).join("");
    const pad = " ".repeat(Math.max(0, 6 - t.trials.length));
    const graded = gradedOf(t);
    const frac = `${t.passes}/${graded}`;
    const shown = graded === 0 ? dim(frac) : t.passes === graded ? green(frac) : red(frac);
    const label = t.critical ? (t.passes < graded ? red("critical") : dim("critical")) : "";
    const notes = [label, taskNote(t)].filter(Boolean).join("  ");
    lines.push(`  ${t.id.padEnd(width)}  ${marks}${pad}  ${shown}${notes ? `${" ".repeat(fracWidth - frac.length)}  ${notes}` : ""}`);
  }
  lines.push("");
  const hats = Object.entries(r.passHat)
    .filter(([j]) => j === "1" || j === String(r.k))
    .map(([j, v]) => `${bold(`pass^${j}`)} ${formatPercent(v)}`);
  // pass@k and the flip rate say something only with more than one trial per task.
  if (r.k > 1 && r.passAt) hats.push(`${bold(`pass@${r.k}`)} ${formatPercent(r.passAt[String(r.k)] ?? Number.NaN)}`);
  if (r.k > 1 && r.flipRate !== undefined) hats.push(`${bold("flip rate")} ${r.flipRate === null ? "n/a" : formatPercent(r.flipRate)}`);
  lines.push(`  ${hats.join("   ")}`);
  if (critical.length) {
    const passed = critical.filter((t) => gradedOf(t) > 0 && t.passes === gradedOf(t)).length;
    const line = `${passed} of ${critical.length} passed every trial`;
    lines.push(`  ${bold("critical")} ${passed === critical.length ? green(line) : red(line)}`);
  }
  const skipped = skippedTrials(r);
  if (skipped.length) {
    const trials = r.tasks.reduce((n, t) => n + t.trials.length, 0);
    lines.push(yellow(`  ${skipped.length} of ${trials} trial(s) skipped (ended in an error): left out of the scores`));
  }
  const notes = r.tasks.flatMap((t) => t.trials.flatMap((tr) => (tr.callerNotes ?? []).map((n) => ({ task: t.id, trial: tr.trial, ...n }))));
  if (notes.length) {
    const trials = new Set(notes.map((n) => `${n.task}#${n.trial}`)).size;
    lines.push(yellow(`  ${notes.length} caller turn(s) in ${trials} trial(s) stepped out of role: see Caller notes`));
  }
  // The estimators need k graded trials of a task to count it in pass^k and pass@k.
  const short = r.tasks.filter((t) => gradedOutcomes(t).length < r.k).length;
  if (short) {
    const tasks = `${short} task${short === 1 ? "" : "s"}`;
    lines.push(dim(r.k === 1 ? `  pass^1 leaves out ${tasks} with no graded trial` : `  pass^${r.k} and pass@${r.k} leave out ${tasks} with fewer than ${r.k} graded trials`));
  }
  lines.push(dim(`  agent turn latency p50 ${formatMs(r.latency.agentTurnP50Ms)} · p95 ${formatMs(r.latency.agentTurnP95Ms)}`));
  const usageLines = [tokenLine("agent", r.usage.agent), tokenLine("user", r.usage.user)].filter(Boolean);
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

  const flaky = r.tasks.filter((t) => t.verdict === "flaky");
  if (flaky.length) {
    lines.push("");
    lines.push(bold("  Flaky tasks") + dim(" (passed some trials, failed others)"));
    const fw = Math.max(...flaky.map((t) => t.id.length));
    for (const t of flaky) {
      const ci = t.interval ? dim(`  95% interval ${formatInterval(t.interval)}`) : "";
      lines.push(`  ${t.id.padEnd(fw)}  ${t.passes} of ${gradedOf(t)} passed${ci}`);
    }
  }

  if (skipped.length) {
    lines.push("");
    lines.push(bold("  Skipped trials") + dim(" (ended in an error, not graded)"));
    // Grouped by error, like failure modes: how many trials, then which tasks.
    const errors = new Map<string, { count: number; tasks: string[] }>();
    for (const tr of skipped) {
      const e = errors.get(tr.error ?? "unknown error") ?? { count: 0, tasks: [] };
      e.count++;
      if (!e.tasks.includes(tr.taskId)) e.tasks.push(tr.taskId);
      errors.set(tr.error ?? "unknown error", e);
    }
    for (const [error, { count, tasks }] of errors) {
      const head = `  ${count}× `;
      lines.push(`  ${yellow(`${count}×`)} ${clip(error, WIDTH - head.length)}`);
      lines.push(dim(`     ${fitList(tasks, WIDTH - 5)}`));
    }
  }

  if (notes.length) {
    lines.push("");
    lines.push(bold("  Caller notes") + dim(" (the simulated user stepped out of role; read these trials first)"));
    for (const n of notes.slice(0, 8)) {
      lines.push(clip(`  ${n.task} #${n.trial + 1} turn ${n.turn}  ${n.why}`, WIDTH));
      lines.push(dim(clip(`     "${n.text}"`, WIDTH)));
    }
    if (notes.length > 8) lines.push(dim(`  … ${notes.length - 8} more in results.json and the report`));
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

  const comparison = comparisonOf(r);
  if (comparison) lines.push("", ...renderComparison(comparison, opts.baseline));
  return lines.join("\n");
}

/**
 * What `sandtable compare` prints: the newer run on two lines, then the block a `run --baseline` summary ends with.
 * `r` carries the baseline as `baseline`; `files` names the two results.json files as the command was given them.
 */
export function renderCompare(r: SuiteResult, files: { baseline: string; results: string }): string {
  const comparison = comparisonOf(r);
  if (!comparison) throw new Error("renderCompare needs a run with a baseline");
  return [
    bold(`sandtable compare · ${r.domain} · ${files.results}`),
    dim(`  run ${r.runId} · started ${r.startedAt} · agent ${r.agent} · user ${r.user} · k=${r.k}`),
    "",
    ...renderComparison(comparison, files.baseline),
  ].join("\n");
}

const CHANGE_MARK: Partial<Record<TaskChange, string>> = { broken: red("✗"), worse: red("↓"), fixed: green("✓"), better: green("↑"), changed: yellow("~") };

/** "(−90.0 pts)", "(+2.5 pts)" or "(no change)" at the precision the percentages are shown. */
function pointsDelta(before: number, after: number): string {
  if (Number.isNaN(before) || Number.isNaN(after)) return "";
  const pts = ((after - before) * 100).toFixed(1);
  if (Number(pts) === 0) return dim("(no change)");
  return pts.startsWith("-") ? red(`(−${pts.slice(1)} pts)`) : green(`(+${pts} pts)`);
}

/**
 * What changed since the baseline, regressions first: one line per task whose result moved or whose test
 * changed, the added, removed, ungraded and unchanged tasks counted on a line each, then pass^1 and pass^k
 * before and after over the tasks both runs ran with the same test.
 */
function renderComparison(c: Comparison, source: string | undefined): string[] {
  const b = c.baseline;
  const lines = [bold(`  Compared with ${source ?? "the baseline run"}`), dim(`  run ${b.runId} · started ${b.startedAt}`)];
  // The agent, the caller and k are this run's (in the first line of the summary) unless a line says otherwise.
  for (const d of c.differences) lines.push(`  ${yellow("!")} ${clip(d, WIDTH - 4)}`);
  if (!c.differences.length) lines.push(dim("  same agent, simulated user and k"));

  const moved = c.tasks.filter((d) => CHANGE_MARK[d.change]);
  const frac = (x?: { passes: number; trials: number }) => (x ? `${x.passes}/${x.trials}` : "–");
  const fracs = moved.map((d) => `${frac(d.before)} → ${frac(d.after)}`);
  const fracWidth = Math.max(0, ...fracs.map((f) => f.length));
  // A changed task says which of its hashes changed: "inputs", "grading" or both.
  const reasons = moved.map((d) => (d.what ?? []).join(", "));
  const reasonWidth = Math.max(0, ...reasons.map((r) => (r ? r.length + 2 : 0)));
  // "  ✗ broken  <id>  1/1 → 0/1": the id column takes what the label, the fractions and a reason leave of 80.
  const idWidth = Math.min(Math.max(0, ...moved.map((d) => d.id.length)), WIDTH - 2 - 2 - 7 - 1 - 2 - fracWidth - reasonWidth);
  if (moved.length) lines.push("");
  moved.forEach((d, i) => {
    const regressed = d.change === "broken" || d.change === "worse";
    const after = d.change === "changed" ? fracs[i]! : regressed ? red(fracs[i]!) : green(fracs[i]!);
    const reason = reasons[i] ? `  ${dim(reasons[i]!)}` : "";
    lines.push(`  ${CHANGE_MARK[d.change]} ${d.change.padEnd(7)} ${clip(d.id, idWidth).padEnd(idWidth)}  ${after.padEnd(after.length + fracWidth - fracs[i]!.length)}${reason}`.trimEnd());
  });
  if (moved.some((d) => d.change === "changed")) lines.push(dim("  ~ changed: its prompts, tools, world or grading differ from the baseline's"));
  const ids = (change: TaskChange) => c.tasks.filter((d) => d.change === change).map((d) => d.id);
  // Added tasks that fail come first: they are new failures too, with nothing to compare them with.
  const failing = c.tasks.filter((d) => d.change === "added" && d.after!.passes < d.after!.trials).map((d) => d.id);
  const added = [...failing, ...ids("added").filter((id) => !failing.includes(id))];
  const removed = ids("removed");
  const same = ids("same").length;
  if (added.length) {
    const head = `  + ${added.length} added${failing.length ? `, ${failing.length} failing` : ""} `;
    lines.push(`${head.replace(/\d+ failing/, (m) => red(m))}${dim(fitList(added, WIDTH - head.length))}`);
  }
  if (removed.length) lines.push(`  − ${removed.length} only in the baseline ${dim(fitList(removed, WIDTH - 27 - String(removed.length).length))}`);
  const ungraded = ids("skipped");
  if (ungraded.length) {
    const head = `  ○ ${ungraded.length} not graded in one of the runs `;
    lines.push(`${head}${dim(fitList(ungraded, WIDTH - head.length))}`);
  }
  if (same) lines.push(dim(`  = ${same} unchanged`));

  lines.push("");
  const left = c.shared - c.comparable;
  if (c.shared === 0) lines.push(dim("  no task ran in both runs, so there is no pass^k to compare"));
  else if (c.comparable === 0) lines.push(dim("  every task both runs ran has a changed test, so there is no pass^k to compare"));
  else {
    const tasks = `${c.comparable} task${c.comparable === 1 ? "" : "s"}`;
    if (left) lines.push(dim(`  over the ${tasks} both runs ran with the same test (${left} changed left out):`));
    else if (!c.sameTasks) lines.push(dim(`  over the ${tasks} both runs ran:`));
    const shown = c.passHat.filter((p) => p.j === 1 || p.j === c.passHat.length);
    for (const p of shown) {
      lines.push(`  ${bold(`pass^${p.j}`)} ${formatPercent(p.before)} → ${formatPercent(p.after)}  ${pointsDelta(p.before, p.after)}`);
    }
  }
  return lines;
}
