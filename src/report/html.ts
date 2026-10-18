import type { SuiteResult } from "../run/suite.ts";

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
:root{--bg:#fbfaf8;--fg:#1d1d1b;--muted:#6b6a66;--card:#fff;--line:#e6e3dd;--ok:#1f7a4d;--bad:#b42318;--chip:#f2efe9;--agent:#eef4ff;--user:#f7f5f0;--tool:#fdf7e7}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe7;--muted:#9c9a94;--card:#1d1d1b;--line:#33322f;--ok:#4cc38a;--bad:#ff6b5e;--chip:#2a2926;--agent:#1c2433;--user:#22211f;--tool:#2b2615}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1040px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:32px 0 12px}
.meta{color:var(--muted);font-size:13px}
.kpis{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;min-width:140px}
.kpi b{display:block;font-size:26px;font-variant-numeric:tabular-nums}.kpi span{color:var(--muted);font-size:12px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--muted);font-weight:600}
tr:last-child td{border-bottom:0}
.dot{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:3px;cursor:pointer;border:0;padding:0}
.ok{background:var(--ok)}.bad{background:var(--bad)}
.okt{color:var(--ok)}.badt{color:var(--bad)}
.chip{display:inline-block;background:var(--chip);border-radius:6px;padding:1px 7px;font-size:12px;margin:2px 4px 2px 0}
.trial{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-top:16px}
.ev{border-radius:8px;padding:8px 12px;margin:6px 0;white-space:pre-wrap;word-break:break-word}
.ev small{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.user{background:var(--user)}.agent{background:var(--agent)}.tool{background:var(--tool);font:12px/1.45 ui-monospace,Menlo,monospace}
.viol{color:var(--bad);font-weight:600}
code{font:12px ui-monospace,Menlo,monospace}
.wrap{overflow-x:auto}
.explain{color:var(--muted);font-size:13px;max-width:760px;margin:10px 0 0}
footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--line)}
a{color:inherit}
.warn{background:var(--tool);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin-top:16px}
</style>
</head>
<body>
<main>
<h1>Sandtable report: <span id="domain"></span></h1>
<div class="meta" id="meta"></div>
<p class="explain">Each task is a simulated conversation, run k times on a fresh copy of the world. A trial passes only if the records end in the expected state and no rule was broken on any tool call or message. No AI judge decides pass or fail. <b>pass^k</b> is the share of tasks where every one of k trials passed.</p>
<div id="pending"></div>
<div class="kpis" id="kpis"></div>
<h2>Tasks</h2>
<div class="wrap"><table><thead><tr><th>Task</th><th>Trials</th><th>Pass</th><th>Failed checks</th></tr></thead><tbody id="tasks"></tbody></table></div>
<div id="tags"></div>
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
const calls = (u) => u ? [u.agent, u.user].flatMap((g) => Object.values(g || {})).reduce((n, x) => n + x.calls, 0) : 0;
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
  '<div class="kpi"><b>' + R.tasks.length + '</b><span>tasks</span></div>' +
  '<div class="kpi"><b>' + R.tasks.reduce((n, t) => n + t.trials.length, 0) + '</b><span>trials</span></div>';
$("tasks").innerHTML = R.tasks.map((t, ti) => {
  const failed = [...new Set(t.trials.flatMap((tr) => tr.checks.filter((c) => !c.passed).map((c) => c.id)))];
  return "<tr><td><b>" + esc(t.id) + "</b><div class='meta'>" + esc(t.description) + "</div></td><td>" +
    t.trials.map((tr, i) => '<button class="dot ' + (tr.passed ? "ok" : "bad") + '" title="trial ' + (i + 1) + '" onclick="show(' + ti + "," + i + ')"></button>').join("") +
    "</td><td class='" + (t.passes === t.trials.length ? "okt" : "badt") + "'>" + t.passes + "/" + t.trials.length + "</td><td>" +
    failed.map((f) => '<span class="chip">' + esc(f) + "</span>").join("") + "</td></tr>";
}).join("");
if (R.byTag && R.byTag.length > 1) {
  $("tags").innerHTML = "<h2>By tag</h2><div class='wrap'><table><thead><tr><th>Tag</th><th>Tasks</th><th>pass^1</th>" + (R.k > 1 ? "<th>pass^" + R.k + "</th>" : "") + "</tr></thead><tbody>" +
    R.byTag.map((t) => "<tr><td><span class='chip'>" + esc(t.tag) + "</span></td><td>" + t.tasks + "</td><td>" + pct(t.passHat1) + "</td>" + (R.k > 1 ? "<td>" + pct(t.passHatK) + "</td>" : "") + "</tr>").join("") +
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
      const v = e.violations.length ? ' <span class="viol">violates ' + e.violations.map(esc).join(", ") + "</span>" : "";
      const out = e.ok ? JSON.stringify(e.result) : "ERROR " + e.error;
      return '<div class="ev tool"><small>tool #' + e.index + v + "</small>" + esc(e.name) + "(" + esc(JSON.stringify(e.args)) + ")\\n→ " + esc(out) + "</div>";
    }
    const lat = e.type === "agent" && e.latencyMs !== undefined ? " · " + ms(e.latencyMs) : "";
    return '<div class="ev ' + e.type + '"><small>' + e.type + lat + "</small>" + esc(e.text) + "</div>";
  }).join("");
  const checks = tr.checks.map((c) => '<div><span class="' + (c.passed ? "okt" : "badt") + '">' + (c.passed ? "✓" : "✗") + "</span> <code>" + esc(c.id) + "</code> " + esc(c.detail) + "</div>").join("");
  const changes = tr.changes.length ? tr.changes.map((c) => "<div><code>" + c.kind + " " + esc(c.table) + " " + esc(c.key) + "</code> " + esc(JSON.stringify(c.after ?? c.before)) + "</div>").join("") : "<div class='meta'>No writes.</div>";
  $("detail").innerHTML = '<div class="trial"><h2 style="margin-top:0">' + esc(t.id) + " · trial " + (i + 1) + " · " +
    (tr.passed ? '<span class="okt">passed</span>' : '<span class="badt">failed</span>') + '</h2><div class="meta">ended: ' + tr.endReason + " · " + tr.turns + " turns · " + tr.durationMs + "ms" + (calls(tr.usage) ? " · " + usd(tr.usage.costUsd) : "") + (tr.error ? " · " + esc(tr.error) : "") +
    "</div><h2>Checks</h2>" + checks + "<h2>World changes</h2>" + changes + "<h2>Transcript</h2>" + evs + "</div>";
  $("detail").scrollIntoView({ behavior: "smooth" });
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
