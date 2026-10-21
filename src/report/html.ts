import type { SuiteResult } from "../run/suite.ts";
import { BRAND_CSS, MARK_SVG } from "./brand.ts";

/**
 * Self-contained HTML report: one file you can attach to a pull request or send to the
 * customer as go-live evidence. No external assets; the run data is embedded as JSON.
 */
export function renderHtml(r: SuiteResult): string {
  const data = JSON.stringify(r).replaceAll("<", "\\u003c");
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
.dots{white-space:nowrap}.dot{display:inline-block;width:12px;height:12px;border-radius:2px;margin-right:4px;cursor:pointer;border:0;padding:0}
.ok{background:var(--ok)}.bad{background:var(--bad)}
.okt{color:var(--ok)}.badt{color:var(--bad-text)}
.chip{display:inline-block;background:var(--chip);border-radius:2px;padding:2px 8px;font-size:12px;line-height:16px;margin:2px 4px 2px 0}
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
</style>
</head>
<body>
<main>
<div class="head">${MARK_SVG}<h1>Sandtable report: <span id="domain"></span></h1></div>
<div class="meta" id="meta"></div>
<p class="explain">Each task is a simulated conversation, run k times on a fresh copy of the world. A trial passes only if the records end in the expected state and no rule was broken on any tool call or message. No AI judge decides pass or fail. <b>pass^k</b> is the share of tasks where every one of k trials passed.</p>
<div id="pending"></div>
<div class="kpis" id="kpis"></div>
<h2>Tasks</h2>
<div class="wrap"><table><thead><tr><th>Task</th><th>Trials</th><th>Pass</th><th>Failed checks</th></tr></thead><tbody id="tasks"></tbody></table></div>
<div id="tags"></div>
<div id="soft"></div>
<h2>Failure modes</h2>
<div class="wrap"><table><thead><tr><th>Count</th><th>Check</th><th>Tasks</th><th>Example</th></tr></thead><tbody id="modes"></tbody></table></div>
<div id="detail"></div>
<footer class="meta">Generated with <a href="https://github.com/sandtable-ai/sandtable">sandtable</a>: rehearse AI agents on a sand table of your customer's world.</footer>
</main>
<script>
const R = ${data};
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
const hats = Object.entries(R.passHat).filter(([j]) => j === "1" || j === String(R.k));
$("kpis").innerHTML = hats.map(([j, v]) => '<div class="kpi"><b>' + pct(v) + '</b><span>pass^' + j + '</span></div>').join("") +
  '<div class="kpi"><b>' + ms(R.latency && R.latency.agentTurnP95Ms) + '</b><span>agent turn p95</span></div>' +
  (calls(R.usage) ? '<div class="kpi"><b>' + usd(R.usage.costUsd) + '</b><span>estimated cost</span></div>' : "") +
  (stops(R.usage) ? '<div class="kpi"><b>' + stops(R.usage) + '</b><span>calls stopped at max_tokens</span></div>' : "") +
  '<div class="kpi"><b>' + R.tasks.length + '</b><span>tasks</span></div>' +
  '<div class="kpi"><b>' + R.tasks.reduce((n, t) => n + t.trials.length, 0) + '</b><span>trials</span></div>';
$("tasks").innerHTML = R.tasks.map((t, ti) => {
  const failed = [...new Set(t.trials.flatMap((tr) => tr.checks.filter((c) => !c.passed).map((c) => c.id)))];
  return "<tr><td><b>" + esc(t.id) + "</b><div class='meta'>" + esc(t.description) + "</div></td><td class='dots'>" +
    t.trials.map((tr, i) => '<button class="dot ' + (tr.passed ? "ok" : "bad") + '" title="trial ' + (i + 1) + '" onclick="show(' + ti + "," + i + ')"></button>').join("") +
    "</td><td class='" + (t.passes === t.trials.length ? "okt" : "badt") + "'>" + t.passes + "/" + t.trials.length + "</td><td>" +
    failed.map((f) => '<span class="chip">' + esc(f) + "</span>").join("") + "</td></tr>";
}).join("");
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
    (tr.passed ? '<span class="okt">passed</span>' : '<span class="badt">failed</span>') + '</h2><div class="meta">ended: ' + tr.endReason + " · " + tr.turns + " turns · " + tr.durationMs + "ms" + (calls(tr.usage) ? " · " + usd(tr.usage.costUsd) : "") + (stops(tr.usage) ? " · " + stops(tr.usage) + " stopped at max_tokens" : "") + (tr.error ? " · " + esc(tr.error) : "") +
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
const firstFail = R.tasks.findIndex((t) => t.trials.some((tr) => !tr.passed));
if (firstFail >= 0) show(firstFail, R.tasks[firstFail].trials.findIndex((tr) => !tr.passed));
</script>
</body>
</html>
`;
}

function escape(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
