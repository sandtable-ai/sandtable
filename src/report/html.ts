import { comparisonOf } from "../run/compare.ts";
import type { SuiteResult } from "../run/suite.ts";
import { BRAND_CSS, MARK_SVG } from "./brand.ts";

/**
 * Self-contained HTML report: one file you can attach to a pull request or send to the
 * customer as go-live evidence. No external assets; the run data is embedded as JSON.
 */
export function renderHtml(r: SuiteResult): string {
  const data = JSON.stringify(r).replaceAll("<", "\\u003c");
  // What changed since the baseline is computed here, so the page holds no comparison logic of its own.
  const comparison = JSON.stringify(comparisonOf(r) ?? null).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sandtable report · ${escape(r.domain)}</title>
<style>
${BRAND_CSS}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 var(--sans)}
main{max-width:1040px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:22px;line-height:32px;margin:0 0 8px}h2{font-size:16px;margin:32px 0 16px}
.meta{color:var(--muted);font-size:13px}
.kpis{display:flex;gap:8px;flex-wrap:wrap;margin:24px 0}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:4px;padding:8px 16px;min-width:144px}
.kpi b{display:block;font-size:26px;line-height:32px;font-variant-numeric:tabular-nums}.kpi span{color:var(--muted);font-size:12px;line-height:16px}
table{width:100%;border-collapse:separate;border-spacing:0;background:var(--card);border:1px solid var(--line);border-radius:4px;overflow:hidden}
th,td{text-align:left;padding:8px 16px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--muted);font-weight:600}
tr:last-child td{border-bottom:0}
.dots,.nw{white-space:nowrap}.dot{display:inline-block;width:12px;height:12px;border-radius:2px;margin-right:4px;cursor:pointer;border:0;padding:0}
.ok{background:var(--ok)}.bad{background:var(--bad)}.skip{background:transparent;box-shadow:inset 0 0 0 2px var(--muted)}
.okt{color:var(--ok)}.badt{color:var(--bad-text)}
.chip{display:inline-block;background:var(--chip);border-radius:2px;padding:2px 8px;font-size:12px;line-height:16px;margin:2px 4px 2px 0}
.crit{font-weight:600}.crit.badc{background:var(--bad);color:#fff}
.trial{background:var(--card);border:1px solid var(--line);border-radius:4px;padding:16px 16px 8px;margin-top:16px;overflow-wrap:anywhere}
.trial h2{margin:24px 0 8px}
.check{display:grid;grid-template-columns:16px 1fr;column-gap:8px;margin:4px 0}
.change{font:13px/20px var(--mono);margin:4px 0}.change span{color:var(--muted)}.change b{font-weight:600}
.change details{display:inline;margin-left:8px}.change summary{display:inline;cursor:pointer;color:var(--muted);font-size:12px}.change details[open] span{display:block}
.change summary::before{content:"▸ "}.change details[open]>summary::before{content:"▾ "}
.ev{border:1px solid transparent;border-radius:4px;padding:8px 16px;margin:8px 0;white-space:pre-wrap}
.ev small{display:block;color:var(--muted);font:12px/16px var(--sans);margin-bottom:4px}
.ev small b{font-weight:600;text-transform:uppercase;letter-spacing:.04em}.ev small code{font-size:1em}
.user{background:var(--chip)}.agent{background:var(--card);border-color:var(--line)}.tool{background:transparent;border:1px dashed var(--line);font:13px/20px var(--mono)}
.viol{color:var(--bad-text);font-weight:600}.viol code{font-weight:600}.softv{color:var(--muted);font-weight:600}
code{font-family:var(--mono);font-size:.867em}code,.change,.tool{font-variant-ligatures:none}
.wrap{overflow-x:auto}
.explain{color:var(--muted);font-size:13px;max-width:760px;margin:8px 0 0}
footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--line)}
a{color:inherit}
.warn{background:var(--chip);border:1px solid var(--line);border-radius:4px;padding:8px 16px;margin-top:16px}
.regressed{color:var(--bad-text);border:1px solid var(--bad);background:transparent;font-weight:600}
.notes{margin:8px 0 16px;padding-left:20px;color:var(--muted);font-size:13px}
</style>
</head>
<body>
<main>
<div class="head">${MARK_SVG}<h1>Sandtable report: <span id="domain"></span></h1></div>
<div class="meta" id="meta"></div>
<p class="explain">Each task is a simulated conversation, run k times on a fresh copy of the world. A trial passes only if the records end in the expected state and no rule was broken on any tool call or message. No AI judge decides pass or fail. <b>pass^k</b> is the share of tasks where every one of k trials passed, and <b>pass@k</b> the share where at least one did. A trial that ended in an error before the agent broke any rule, such as a rate limit that outlasted the retries, is skipped: it is shown hollow and left out of the scores.</p>
<div id="pending"></div>
<div class="kpis" id="kpis"></div>
<div id="baseline"></div>
<h2>Tasks</h2>
<div class="wrap"><table><thead><tr><th>Task</th><th>Trials</th><th>Pass</th><th>Verdict</th><th>Failed checks</th></tr></thead><tbody id="tasks"></tbody></table></div>
<div id="flaky"></div>
<div id="skipped"></div>
<div id="tags"></div>
<div id="soft"></div>
<h2>Failure modes</h2>
<div class="wrap"><table><thead><tr><th>Count</th><th>Check</th><th>Tasks</th><th>Example</th></tr></thead><tbody id="modes"></tbody></table></div>
<div id="detail"></div>
<footer class="meta">Generated with <a href="https://github.com/sandtable-ai/sandtable">sandtable</a>: rehearse AI agents on a sand table of your customer's world.</footer>
</main>
<script>
const R = ${data};
const C = ${comparison};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const pct = (x) => Number.isNaN(x) || x === null ? "n/a" : (x * 100).toFixed(1) + "%";
const ms = (v) => v === null || v === undefined ? "n/a" : v < 1000 ? v + "ms" : (v / 1000).toFixed(1) + "s";
const usd = (v) => v === null || v === undefined ? "n/a" : v > 0 && v < 0.01 ? "<$0.01" : "$" + v.toFixed(2);
// JSON with a space after each comma and colon, so long rows wrap between fields, not inside values.
const json = (v) => v === undefined ? "" : JSON.stringify(v, null, 1).replace(/\\n\\s*/g, " ");
const calls = (u) => u ? [u.agent, u.user].flatMap((g) => Object.values(g || {})).reduce((n, x) => n + x.calls, 0) : 0;
// Model calls whose reply stopped at max_tokens, agent and caller together.
const stops = (u) => u ? [u.agent, u.user].flatMap((g) => Object.values(g || {})).reduce((n, x) => n + (x.maxTokensStops || 0), 0) : 0;
$("domain").textContent = R.domain;
$("meta").textContent = "agent " + R.agent + " · user " + R.user + " · k=" + R.k + " · " + R.startedAt + " · " + (R.durationMs / 1000).toFixed(1) + "s";
if (R.pendingReview && R.pendingReview.length) {
  $("pending").innerHTML = '<div class="warn"><b>Provisional:</b> ' + R.pendingReview.length + " drafted item(s) are pending review: " +
    R.pendingReview.map((p) => '<span class="chip">' + esc(p.kind + " " + p.id) + "</span>").join("") + "</div>";
}
// Results from before verdicts have no graded count or verdict: every trial was graded then.
const graded = (t) => t.graded ?? t.trials.length;
const verdict = (t) => t.verdict || (t.passes === graded(t) ? "passed" : t.passes === 0 ? "failed" : "flaky");
const status = (tr) => tr.skipped ? "skipped" : tr.passed ? "passed" : "failed";
const interval = (i) => i ? Math.round(i.low * 100) + "%–" + Math.round(i.high * 100) + "%" : "n/a";
const skippedTrials = R.tasks.flatMap((t) => t.trials.filter((tr) => tr.skipped));
const hats = Object.entries(R.passHat).filter(([j]) => j === "1" || j === String(R.k));
const allPassed = (t) => graded(t) > 0 && t.passes === graded(t);
const critFailed = (t) => t.passes < graded(t);
// Critical tasks first, then the rest, both in spec order. Indexes stay those of R.tasks, which show() reads.
const order = [...R.tasks.keys()].sort((a, b) => Number(!R.tasks[a].critical) - Number(!R.tasks[b].critical) || a - b);
const critical = R.tasks.filter((t) => t.critical);
$("kpis").innerHTML = hats.map(([j, v]) => '<div class="kpi"><b>' + pct(v) + '</b><span>pass^' + j + '</span></div>').join("") +
  (critical.length ? '<div class="kpi"><b class="' + (critical.every(allPassed) ? "" : "badt") + '">' + critical.filter(allPassed).length + " of " + critical.length + '</b><span>critical tasks passed every trial</span></div>' : "") +
  (R.k > 1 && R.passAt ? '<div class="kpi"><b>' + pct(R.passAt[String(R.k)] ?? null) + '</b><span>pass@' + R.k + '</span></div>' : "") +
  (R.k > 1 && R.flipRate !== undefined ? '<div class="kpi"><b>' + pct(R.flipRate) + '</b><span>flip rate</span></div>' : "") +
  (skippedTrials.length ? '<div class="kpi"><b>' + skippedTrials.length + '</b><span>trials skipped</span></div>' : "") +
  '<div class="kpi"><b>' + ms(R.latency && R.latency.agentTurnP95Ms) + '</b><span>agent turn p95</span></div>' +
  (calls(R.usage) ? '<div class="kpi"><b>' + usd(R.usage.costUsd) + '</b><span>estimated cost</span></div>' : "") +
  (stops(R.usage) ? '<div class="kpi"><b>' + stops(R.usage) + '</b><span>calls stopped at max_tokens</span></div>' : "") +
  '<div class="kpi"><b>' + R.tasks.length + '</b><span>tasks</span></div>' +
  '<div class="kpi"><b>' + R.tasks.reduce((n, t) => n + t.trials.length, 0) + '</b><span>trials</span></div>';
// Since the baseline: what changed, regressions first, then the scores before and after.
const since = C ? Object.fromEntries(C.tasks.map((d) => [d.id, d.change])) : {};
const regressed = (id) => since[id] === "broken" || since[id] === "worse";
if (C) {
  const b = C.baseline;
  const frac = (x) => x ? x.passes + "/" + x.trials : "–";
  const moved = C.tasks.filter((d) => d.change !== "same");
  const same = C.tasks.length - moved.length;
  const label = { broken: "broken", worse: "worse", fixed: "fixed", better: "better", added: "added", removed: "only in the baseline", skipped: "not graded in one run" };
  const shown = C.passHat.filter((p) => p.j === 1 || p.j === C.passHat.length);
  const pts = (p) => { const d = (p.after - p.before) * 100; return Number.isNaN(d) ? "" : Math.abs(d) < 0.05 ? "no change" : (d > 0 ? "+" : "−") + Math.abs(d).toFixed(1) + " pts"; };
  $("baseline").innerHTML = "<h2>Changes since baseline</h2><p class='explain' style='margin-top:0'>Compared with run <code>" + esc(b.runId) + "</code> of " + esc(b.startedAt) +
    ": agent " + esc(b.agent) + ", user " + esc(b.user) + ", k=" + b.k + ". Regressions come first.</p>" +
    (C.differences.length ? "<ul class='notes'>" + C.differences.map((d) => "<li>" + esc(d) + "</li>").join("") + "</ul>" : "") +
    (C.shared ? "<div class='wrap'><table><thead><tr><th>Score" + (C.sameTasks ? "" : " (over the " + C.shared + " tasks both runs ran)") + "</th><th>Baseline</th><th>Now</th><th>Change</th></tr></thead><tbody>" +
      shown.map((p) => "<tr><td>pass^" + p.j + "</td><td>" + pct(p.before) + "</td><td>" + pct(p.after) + "</td><td class='" + ((p.after - p.before) * 100 <= -0.05 ? "badt" : "") + "'>" + pts(p) + "</td></tr>").join("") +
      "</tbody></table></div>" : "<p class='meta'>No task ran in both runs, so there is no pass^k to compare.</p>") +
    (moved.length ? "<div class='wrap' style='margin-top:16px'><table><thead><tr><th>Change</th><th>Task</th><th>Baseline</th><th>Now</th></tr></thead><tbody>" +
      moved.map((d) => {
        const cls = regressed(d.id) ? "badt" : d.change === "fixed" || d.change === "better" ? "okt" : "meta";
        return "<tr><td class='" + cls + "'>" + (regressed(d.id) ? "<b>" + label[d.change] + "</b>" : label[d.change]) + "</td><td><code>" + esc(d.id) + "</code></td><td>" + frac(d.before) + "</td><td class='" + cls + "'>" + frac(d.after) + "</td></tr>";
      }).join("") + "</tbody></table></div>" : "") +
    "<p class='meta'>" + (moved.length ? same + " task" + (same === 1 ? "" : "s") + " unchanged." : "No task changed: all " + same + " have the same result as in the baseline.") + "</p>";
}
$("tasks").innerHTML = order.map((ti) => {
  const t = R.tasks[ti];
  // A skipped trial's error is listed under Skipped trials, not as the task's failure.
  const failed = [...new Set(t.trials.filter((tr) => !tr.skipped).flatMap((tr) => tr.checks.filter((c) => !c.passed).map((c) => c.id)))];
  const crit = t.critical ? ' <span class="chip crit' + (critFailed(t) ? " badc" : "") + '" title="' + (critFailed(t) ? "critical: a failed trial fails the run" : allPassed(t) ? "critical: passed every trial" : "critical: no trial was graded") + '">critical</span>' : "";
  return "<tr><td><b>" + esc(t.id) + "</b>" + crit + (regressed(t.id) ? ' <span class="chip regressed">' + since[t.id] + " since baseline</span>" : "") + "<div class='meta'>" + esc(t.description) + "</div></td><td class='dots'>" +
    t.trials.map((tr, i) => '<button class="dot ' + ({ passed: "ok", failed: "bad", skipped: "skip" })[status(tr)] + '" title="trial ' + (i + 1) + (tr.skipped ? ": skipped" : "") + '" onclick="show(' + ti + "," + i + ')"></button>').join("") +
    "</td><td class='nw " + (graded(t) === 0 ? "meta" : t.passes === graded(t) ? "okt" : "badt") + "'>" + t.passes + "/" + graded(t) +
    (t.skipped ? "<div class='meta'>" + t.skipped + " skipped</div>" : "") + "</td><td class='nw'><span class='" + ({ passed: "okt", failed: "badt", flaky: "badt", skipped: "meta" })[verdict(t)] + "'>" + verdict(t) + "</span>" +
    (t.interval ? "<div class='meta' title='95% Wilson interval for the pass rate of the graded trials'>95% " + interval(t.interval) + "</div>" : "") + "</td><td>" +
    failed.map((f) => '<span class="chip">' + esc(f) + "</span>").join("") + "</td></tr>";
}).join("");
const flaky = R.tasks.filter((t) => verdict(t) === "flaky");
if (flaky.length) {
  $("flaky").innerHTML = "<h2>Flaky tasks</h2><p class='explain' style='margin-top:0'>Passed some trials and failed others: the agent can do the task, but not every time. The interval is a 95% Wilson interval for the pass rate; few trials make it wide.</p><div class='wrap'><table><thead><tr><th>Task</th><th>Passed</th><th>95% interval</th><th>Failed checks</th></tr></thead><tbody>" +
    flaky.map((t) => "<tr><td><b>" + esc(t.id) + "</b></td><td>" + t.passes + " of " + graded(t) + "</td><td>" + interval(t.interval) + "</td><td>" +
      [...new Set(t.trials.filter((tr) => !tr.passed && !tr.skipped).flatMap((tr) => tr.checks.filter((c) => !c.passed).map((c) => c.id)))].map((f) => '<span class="chip">' + esc(f) + "</span>").join("") + "</td></tr>").join("") +
    "</tbody></table></div>";
}
if (skippedTrials.length) {
  // Grouped by error, like failure modes: how many trials, then which tasks.
  const errors = new Map();
  for (const tr of skippedTrials) {
    const e = errors.get(tr.error || "unknown error") || { count: 0, tasks: [] };
    e.count++;
    if (!e.tasks.includes(tr.taskId)) e.tasks.push(tr.taskId);
    errors.set(tr.error || "unknown error", e);
  }
  $("skipped").innerHTML = "<h2>Skipped trials</h2><p class='explain' style='margin-top:0'>These trials ended in an error before the agent broke any rule, so they were not graded and the scores leave them out. The run is incomplete: rerun it.</p><div class='wrap'><table><thead><tr><th>Count</th><th>Error</th><th>Tasks</th></tr></thead><tbody>" +
    [...errors].map(([error, e]) => "<tr><td>" + e.count + "×</td><td>" + esc(error) + "</td><td>" + e.tasks.map((t) => '<span class="chip">' + esc(t) + "</span>").join("") + "</td></tr>").join("") +
    "</tbody></table></div>";
}
if (R.byTag && R.byTag.length > 1) {
  $("tags").innerHTML = "<h2>By tag</h2><div class='wrap'><table><thead><tr><th>Tag</th><th>Tasks</th><th>pass^1</th>" + (R.k > 1 ? "<th>pass^" + R.k + "</th>" : "") + "</tr></thead><tbody>" +
    R.byTag.map((t) => "<tr><td><span class='chip'>" + esc(t.tag) + "</span></td><td>" + t.tasks + "</td><td>" + pct(t.passHat1) + "</td>" + (R.k > 1 ? "<td>" + pct(t.passHatK) + "</td>" : "") + "</tr>").join("") +
    "</tbody></table></div>";
}
if (R.soft && R.soft.length) {
  const rate = (x) => x.rate === null ? "n/a" : pct(x.rate);
  const scope = (x) => x.tool ? "trials that called <code>" + esc(x.tool) + "</code>" : "trials";
  $("soft").innerHTML = "<h2>Soft rules</h2><p class='explain' style='margin-top:0'>Checked on every call like the other rules, but breaking one never fails a trial. The rate is the share of trials where the rule applied and the agent broke it.</p><div class='wrap'><table><thead><tr><th>Rule</th><th>Rate</th><th>Broken in</th><th>Tasks</th><th>Example</th></tr></thead><tbody>" +
    R.soft.map((x) => "<tr><td><code>" + esc(x.id) + "</code><div class='meta'>" + esc(x.description) + "</div></td><td>" + rate(x) + "</td><td>" + x.broken + " of " + x.applied + " " + scope(x) + "</td><td>" +
      x.tasks.map((t) => '<span class="chip">' + esc(t) + "</span>").join("") + "</td><td>" + esc(x.example || "") + "</td></tr>").join("") +
    "</tbody></table></div>";
}
$("modes").innerHTML = R.failureModes.length ? R.failureModes.map((m) =>
  "<tr><td class='badt'>" + m.count + "×</td><td><code>" + esc(m.id) + "</code><div class='meta'>" + esc(m.kind) + "</div></td><td>" +
  m.tasks.map((t) => '<span class="chip">' + esc(t) + "</span>").join("") + "</td><td>" + esc(m.example) + "</td></tr>").join("")
  : "<tr><td colspan='4' class='okt'>No failures.</td></tr>";
function show(ti, i) {
  const t = R.tasks[ti], tr = t.trials[i];
  const evs = tr.events.map((e) => {
    if (e.type === "tool") {
      const v = (e.violations.length ? ' · <span class="viol">violates ' + e.violations.map((id) => "<code>" + esc(id) + "</code>").join(", ") + "</span>" : "") +
        (e.soft && e.soft.length ? ' · <span class="softv">soft ' + e.soft.map((id) => "<code>" + esc(id) + "</code>").join(", ") + "</span>" : "");
      const out = e.ok ? json(e.result) : "ERROR " + e.error;
      return '<div class="ev tool"><small><b>tool</b> #' + e.index + v + "</small>" + esc(e.name) + "(" + esc(json(e.args)) + ")\\n→ " + esc(out) + "</div>";
    }
    const lat = e.type === "agent" && e.latencyMs !== undefined ? " · " + ms(e.latencyMs) : "";
    return '<div class="ev ' + e.type + '"><small><b>' + e.type + "</b>" + lat + "</small>" + esc(e.text) + "</div>";
  }).join("");
  const checks = tr.checks.map((c) => '<div class="check"><span class="' + (c.passed ? "okt" : "badt") + '">' + (c.passed ? "✓" : "✗") + "</span><div><code>" + esc(c.id) + "</code> " + esc(c.detail) + "</div></div>").join("") +
    (tr.soft || []).map((c) => '<div class="check"><span class="meta">' + (c.broken ? "~" : "·") + "</span><div><code>" + esc(c.id) + "</code> <span class='meta'>soft:</span> " + esc(c.broken ? c.violations.map((v) => v.detail).join("; ") : "not broken") + "</div></div>").join("");
  const changes = tr.changes.length ? tr.changes.map(change).join("") : "<div class='meta'>No writes.</div>";
  $("detail").innerHTML = '<div class="trial"><h2 style="margin-top:0">' + esc(t.id) + " · trial " + (i + 1) + " · " +
    ({ passed: '<span class="okt">passed</span>', failed: '<span class="badt">failed</span>', skipped: '<span class="meta">skipped: it ended in an error before the agent broke any rule, so it was not graded</span>' })[status(tr)] + '</h2><div class="meta">ended: ' + tr.endReason + " · " + tr.turns + " turns · " + tr.durationMs + "ms" + (calls(tr.usage) ? " · " + usd(tr.usage.costUsd) : "") + (stops(tr.usage) ? " · " + stops(tr.usage) + " stopped at max_tokens" : "") + (tr.error ? " · " + esc(tr.error) : "") +
    "</div><h2>Checks</h2>" + checks + "<h2>World changes</h2>" + changes + "<h2>Transcript</h2>" + evs + "</div>";
  $("detail").scrollIntoView({ behavior: "smooth" });
}
// An update shows only the fields it changed, before → after, with the whole row behind a toggle; an insert or a
// delete shows the row.
function change(c) {
  const head = '<div class="change">' + esc(c.kind) + " " + esc(c.table) + " " + esc(c.key) + " ";
  if (c.kind !== "update" || !c.before || !c.after) return head + "<span>" + esc(json(c.after ?? c.before)) + "</span></div>";
  const shown = (v) => v === undefined ? "(unset)" : json(v);
  const fields = Object.keys({ ...c.before, ...c.after }).filter((k) => JSON.stringify(c.before[k]) !== JSON.stringify(c.after[k]));
  const diff = fields.map((k) => "<b>" + esc(k) + "</b> " + esc(shown(c.before[k])) + " → " + esc(shown(c.after[k]))).join(", ");
  return head + (diff || "<span>no field changed</span>") + "<details><summary>whole row</summary><span>" + esc(json(c.after)) + "</span></details></div>";
}
// Open the first failed trial in the order the table lists tasks, so a failed critical task comes first; else the first skipped one.
for (const want of ["failed", "skipped"]) {
  const ti = order.find((i) => R.tasks[i].trials.some((tr) => status(tr) === want));
  if (ti !== undefined) {
    show(ti, R.tasks[ti].trials.findIndex((tr) => status(tr) === want));
    break;
  }
}
</script>
</body>
</html>
`;
}

function escape(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
