import type { RuleCoverage } from "../run/coverage.ts";
import type { TrajectoryEvent, TrialResult } from "../run/episode.ts";
import type { SuiteResult, TaskSummary } from "../run/suite.ts";
import { BRAND_CSS, MARK_SVG } from "./brand.ts";

export interface CustomerReportOptions {
  /**
   * A run of a careless agent on the same domain. A rule it broke shows as caught: the rehearsal failed the
   * conversations in which it was broken. Without one, the page says which rules were checked, not which are caught.
   */
  probe?: SuiteResult;
}

/**
 * The page a customer's operations lead can sign off on before go-live, from a run's `results.json`: a plain-language
 * summary with the open items, each rule of the operating procedure with its quoted source, the scenarios that checked
 * it and an example conversation, the scenarios, and what the rehearsal doesn't cover. Static HTML with no script, so
 * it prints. The run needs `coverage` (results written by sandtable-ai 1.1 or later, or regraded since).
 */
export function renderCustomerHtml(r: SuiteResult, opts: CustomerReportOptions = {}): string {
  if (!r.coverage) throw new Error("this run has no coverage: it was written before sandtable-ai 1.1. Regrade it with the current version first");
  const { probe } = opts;
  if (probe && !probe.coverage) throw new Error("the probe run has no coverage: it was written before sandtable-ai 1.1. Regrade it with the current version first");
  if (probe && probe.domain !== r.domain) throw new Error(`the probe is a run of ${probe.domain}, not ${r.domain}: pass a run of the same domain`);
  const rules = r.coverage.rules;
  const trials = r.tasks.reduce((n, t) => n + t.trials.length, 0);
  const passedAll = r.tasks.filter(passedEvery);
  const critical = r.tasks.filter((t) => t.critical);
  const checked = rules.filter((x) => x.checked > 0);
  const brokenHard = rules.filter((x) => x.broken > 0 && !x.soft);
  const unchecked = rules.filter((x) => x.checked === 0);
  const idle = r.coverage.tools.filter((t) => t.calls === 0);
  const caught = probe ? new Map(probe.coverage!.rules.map((x) => [x.id, x])) : undefined;
  const k = r.k;

  const open: string[] = [];
  if (r.pendingReview.length) open.push(`${count(r.pendingReview.length, "item")} drafted from your documents ${r.pendingReview.length === 1 ? "hasn't" : "haven't"} been reviewed by a person yet, so these results are provisional.`);
  const skipped = r.tasks.reduce((n, t) => n + (t.skipped ?? 0), 0);
  if (skipped) open.push(`${count(skipped, "conversation")} ended in an error before ${skipped === 1 ? "it" : "they"} could be graded, so the rehearsal is incomplete. Rerun it.`);
  for (const t of critical.filter((t) => t.passes < graded(t))) open.push(`Critical scenario ${quoted(name(t))} failed in ${graded(t) - t.passes} of ${count(graded(t), "conversation")}.`);
  for (const x of brokenHard) open.push(`The rule ${quoted(x.description)} was broken in ${count(x.broken, "conversation")}.`);
  const weak = r.tasks.filter((t) => !t.critical && graded(t) > 0 && t.passes < graded(t));
  if (weak.length) {
    const named = weak.slice(0, 3).map((t) => quoted(name(t))).join(", ");
    open.push(`${count(weak.length, "scenario")} didn't pass every conversation: ${named}${weak.length > 3 ? `, and ${weak.length - 3} more in Scenarios` : ""}.`);
  }

  const facts = [
    `${esc(r.agent)} was rehearsed on ${count(r.tasks.length, "scenario")}, ${count(k, "conversation")} each (${trials} in all), with simulated callers and a simulated copy of your systems. Every conversation was graded by fixed rules, not by an AI judge.`,
    `${passedAll.length} of ${r.tasks.length} scenarios passed in every conversation.`,
    ...(critical.length ? [`${critical.filter(passedEvery).length} of ${critical.length} critical scenarios passed in every conversation.`] : []),
    `${checked.length} of ${rules.length} rules were checked in these conversations${brokenHard.length ? `, and ${count(brokenHard.length, "rule")} ${brokenHard.length === 1 ? "was" : "were"} broken` : ", and none was broken"}.${unchecked.length ? ` ${count(unchecked.length, "rule")} ${unchecked.length === 1 ? "was" : "were"} never checked: see Not covered.` : ""}`,
    ...(probe && caught
      ? [`A deliberately careless agent was rehearsed too. The rehearsal caught it breaking ${[...caught.values()].filter((x) => x.broken > 0 && !x.soft).length} of the ${rules.filter((x) => !x.soft).length} rules that fail a conversation.`]
      : []),
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Go-live rehearsal · ${esc(r.domain)}</title>
<style>
${BRAND_CSS}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 var(--sans)}
main{max-width:860px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:24px;line-height:32px;margin:0 0 8px}h2{font-size:18px;margin:40px 0 12px}h3{font-size:16px;margin:0 0 4px}
.meta{color:var(--muted);font-size:13px}
.status{border:1px solid var(--line);background:var(--card);border-radius:4px;padding:16px;margin:24px 0}
.status b.big{display:block;font-size:20px;line-height:28px;margin-bottom:8px}
.status.bad{border-color:var(--bad)}.badt{color:var(--bad-text)}.okt{color:var(--ok)}
ul{padding-left:20px;margin:8px 0}li{margin:4px 0}
.rule{background:var(--card);border:1px solid var(--line);border-radius:4px;padding:16px;margin:12px 0;break-inside:avoid}
.rule.gap{border-left:4px solid var(--bad)}
blockquote{margin:8px 0;padding:4px 12px;border-left:3px solid var(--line);color:var(--muted)}
blockquote cite{display:block;font-style:normal;font-size:12px}
.chip{display:inline-block;background:var(--chip);border-radius:2px;padding:0 8px;font-size:12px;line-height:20px;margin:0 4px 0 0;vertical-align:1px}
.chip.bad{background:var(--bad);color:#fff}.chip.line{background:transparent;border:1px solid var(--bad);color:var(--bad-text)}
code{font-family:var(--mono);font-size:.875em}
details{margin:8px 0}summary{cursor:pointer;color:var(--muted);font-size:14px}
.conv{border:1px solid var(--line);border-radius:4px;padding:8px 12px;margin-top:8px;background:var(--bg)}
.turn{margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere}.turn span{display:block;font-size:12px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.act{font:13px/20px var(--mono);color:var(--muted);margin:4px 0;overflow-wrap:anywhere}.act .badt{font-family:var(--sans);font-weight:600}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);font-size:14px}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--muted)}
.wrap{overflow-x:auto}
.sign{margin-top:40px;border-top:1px solid var(--line);padding-top:16px;break-inside:avoid}
.sign div{display:flex;gap:16px;flex-wrap:wrap;margin-top:24px}.sign span{flex:1 1 200px;border-bottom:1px solid var(--fg);padding-top:24px;font-size:12px;color:var(--muted)}
@media print{body{background:#fff}main{padding:0}.status,.rule,table{background:#fff}}
</style>
</head>
<body>
<main>
<div class="head">${MARK_SVG}<h1>Go-live rehearsal: ${esc(r.domain)}</h1></div>
<div class="meta">${esc(r.agent)} · rehearsed ${esc(r.startedAt.slice(0, 10))} · ${count(r.tasks.length, "scenario")} × ${count(k, "conversation")} · run ${esc(r.runId)}</div>

<div class="status${open.length ? " bad" : ""}">
<b class="big${open.length ? " badt" : ""}">${open.length ? `${count(open.length, "open item")} before go-live` : "No open items"}</b>
<ul>${facts.map((f) => `<li>${f}</li>`).join("")}</ul>
${open.length ? `<b>Open items</b><ul>${open.map((o) => `<li>${o}</li>`).join("")}</ul>` : ""}
<p class="meta">The decision to go live is yours: this page lays out the evidence. How to read it is at the end.</p>
</div>

<h2>Rules from your operating procedure</h2>
<p class="meta">Each rule the agent must follow, where it comes from, and what the rehearsal saw. A rule is <b>checked</b> in a conversation when the agent took the action it governs, or, for a rule about what the agent may say, saw information it must keep to itself. Checked means the rule applied, not that the scenario tried to make the agent break it.${probe ? " A rule is <b>caught</b> when a deliberately careless agent broke it and the rehearsal failed those conversations: that proves these scenarios catch the mistake." : " Which rules the rehearsal would catch a careless agent breaking isn't shown: rehearse a careless agent too to show it."}</p>
${rules.map((x) => ruleCard(x, r, probe, caught?.get(x.id))).join("\n")}

<h2>Scenarios</h2>
<div class="wrap"><table><thead><tr><th>Scenario</th><th>Result</th></tr></thead><tbody>
${[...critical, ...r.tasks.filter((t) => !t.critical)].map((t) => `<tr><td>${esc(name(t))}${t.critical ? ' <span class="chip">critical</span>' : ""}<div class="meta">${esc(t.id)}${t.tags.length ? ` · ${t.tags.map(esc).join(", ")}` : ""}</div></td><td>${result(t)}</td></tr>`).join("\n")}
</tbody></table></div>

<h2>Not covered by this rehearsal</h2>
<ul>
${unchecked.length ? `<li><b>${count(unchecked.length, "rule")} no conversation checked.</b> A passing rehearsal says nothing about ${unchecked.length === 1 ? "it" : "them"}: ${unchecked.map((x) => quoted(x.description)).join("; ")}.</li>` : "<li>Every rule was checked in at least one conversation.</li>"}
${idle.length ? `<li><b>Actions the agent never took:</b> ${idle.map((t) => `<code>${esc(t.name)}</code>`).join(", ")}. Whatever those actions do in your systems wasn't rehearsed.</li>` : ""}
${rules.some((x) => x.soft) ? `<li><b>Soft rules</b> are reported but never fail a conversation, so the rehearsal can't catch them: ${rules.filter((x) => x.soft).map((x) => `${quoted(x.description)} (broken in ${x.broken} of ${x.checked} conversations where it applied)`).join("; ")}.</li>` : ""}
<li>Callers are simulated from written instructions. The agent's tools act on a simulated copy of your systems holding the records of this rehearsal, not on your live systems.</li>
<li>Conversations are graded only by the rules and expected outcomes on this page. Tone, wording and anything not written down as a rule or an expected outcome aren't graded.</li>
<li>Each scenario ran ${count(k, "time")}. A rare mistake can still happen in production: more conversations per scenario make a rare one more likely to show up here.</li>
</ul>

<h2>How to read this page</h2>
<ul>
<li>A scenario <b>passed every conversation</b> when, in each of its ${count(k, "conversation")}, the records ended as expected and no rule was broken. One failed conversation is enough to count it as not passed.</li>
<li>A <b>critical</b> scenario is a release blocker: it must pass every conversation.</li>
<li>A rule <b>checked</b> in a conversation applied to what the agent did. ${probe ? "A rule <b>caught</b> was broken by a deliberately careless agent, and the rehearsal failed those conversations." : "To show which mistakes the rehearsal catches, an engineer can rehearse a deliberately careless agent and add it to this page."}</li>
<li>Example conversations are copied from the rehearsal. Names, IDs and records in them are the rehearsal's own test data.</li>
</ul>

<div class="sign">
<b>Sign-off</b>
<div><span>Reviewed and accepted by</span><span>Role</span><span>Date</span></div>
</div>
<p class="meta">Generated with <a href="https://github.com/sandtable-ai/sandtable" style="color:inherit">sandtable</a> from run ${esc(r.runId)}${probe ? ` and careless-agent run ${esc(probe.runId)}` : ""}.</p>
</main>
</body>
</html>
`;
}

function ruleCard(x: RuleCoverage, r: SuiteResult, probe: SuiteResult | undefined, careless: RuleCoverage | undefined): string {
  const tasks = new Map(r.tasks.map((t) => [t.id, t]));
  const cells = x.tasks.filter((c) => c.checked > 0);
  const status =
    x.checked === 0
      ? `<span class="chip line">not checked</span> No conversation in this rehearsal reached this rule.`
      : x.broken > 0
        ? x.soft
          ? `<span class="chip">reported</span> Broken in ${x.broken} of the ${count(x.checked, "conversation")} where it applied. It is a soft rule: reported, never a reason to fail a conversation.`
          : `<span class="chip bad">broken</span> Broken in ${x.broken} of the ${count(x.checked, "conversation")} where it applied.`
        : `<span class="chip">held</span> Held in all ${count(x.checked, "conversation")} where it applied, across ${count(cells.length, "scenario")}.`;
  // Caught means a careless agent broke the rule and the rehearsal failed it for that. A soft rule never fails a
  // conversation, so the most a probe shows for one is that the rehearsal reports it.
  const caught = !probe
    ? ""
    : careless && careless.broken > 0
      ? x.soft
        ? `<p><span class="chip">reported</span> A deliberately careless agent broke it in ${count(careless.tasks.filter((c) => c.broken > 0).length, "scenario")}, and the rehearsal reported it. As a soft rule, it never fails a conversation, so it can't be caught.</p>`
        : `<p><span class="chip">caught</span> A deliberately careless agent broke it in ${count(careless.tasks.filter((c) => c.broken > 0).length, "scenario")}, and the rehearsal failed those conversations.</p>`
      : `<p><span class="chip line">not shown caught</span> The careless agent didn't break it, so these scenarios aren't shown to catch this mistake.</p>`;
  const example = exampleTrial(r, x);
  const probeExample = probe && careless && careless.broken > 0 ? exampleTrial(probe, careless, true) : undefined;
  const list = cells.map((c) => `<li>${esc(name(tasks.get(c.task)!))}: ${result(tasks.get(c.task)!)}</li>`).join("");
  return `<div class="rule${x.checked === 0 ? " gap" : ""}">
<h3>${esc(x.description)}${x.soft ? ' <span class="chip">soft rule</span>' : ""}</h3>
${x.source?.quote ? `<blockquote>“${inline(x.source.quote)}”<cite>${esc(x.source.file)}</cite></blockquote>` : x.source ? `<blockquote><cite>from ${esc(x.source.file)}</cite></blockquote>` : ""}
<p>${status}</p>
${caught}
${cells.length ? `<details><summary>Scenarios that checked it (${cells.length})</summary><ul>${list}</ul></details>` : ""}
${example ? `<details><summary>Example conversation: ${esc(name(example.task))}, conversation ${example.trial.trial + 1}${example.broke ? " (broke the rule)" : ""}</summary>${conversation(example.trial, r)}</details>` : ""}
${probeExample ? `<details><summary>How the careless agent was caught: ${esc(name(probeExample.task))}</summary>${conversation(probeExample.trial, probe!)}</details>` : ""}
<div class="meta">${esc(x.id)} · ${esc(x.kind)} · ${esc(x.tool ?? x.field ?? "")}</div>
</div>`;
}

/** The trial to show for a rule: the first that broke it, else the first that called its tool (any trial of a task that checked it, for never_disclose). */
function exampleTrial(r: SuiteResult, x: RuleCoverage, brokenOnly = false): { task: TaskSummary; trial: TrialResult; broke: boolean } | undefined {
  for (const c of x.tasks.filter((c) => c.broken > 0)) {
    const task = r.tasks.find((t) => t.id === c.task)!;
    const trial = task.trials.find((tr) => broke(tr, x.id));
    if (trial) return { task, trial, broke: true };
  }
  if (brokenOnly) return undefined;
  for (const c of x.tasks.filter((c) => c.checked > 0)) {
    const task = r.tasks.find((t) => t.id === c.task)!;
    const trial = task.trials.find((tr) => !x.tool || tr.events.some((e) => e.type === "tool" && e.name === x.tool));
    if (trial) return { task, trial, broke: false };
  }
  return undefined;
}

function broke(tr: TrialResult, id: string): boolean {
  return tr.violations.some((v) => v.invariant === id) || (tr.soft ?? []).some((c) => c.id === id && c.broken);
}

/** A trial as a conversation a non-engineer can follow: what each side said, the agent's actions and the verdict. */
function conversation(tr: TrialResult, r: SuiteResult): string {
  const rules = new Map(r.coverage!.rules.map((x) => [x.id, x.description]));
  const said = (e: TrajectoryEvent) => {
    if (e.type === "tool") {
      const broken = [...e.violations, ...(e.soft ?? [])].map((id) => rules.get(id) ?? id);
      const outcome = e.ok ? "done" : `refused: ${e.error ?? "error"}`;
      return `<div class="act">Agent action: ${esc(e.name)}(${esc(args(e.args))}) → ${esc(outcome)}${broken.length ? ` <span class="badt">broke: ${broken.map(esc).join("; ")}</span>` : ""}</div>`;
    }
    return `<div class="turn"><span>${e.type === "user" ? "Caller" : "Agent"}</span>${esc(e.text)}</div>`;
  };
  const verdict = tr.skipped
    ? "Not graded: it ended in an error."
    : tr.passed
      ? "This conversation passed."
      : `This conversation failed: ${[...new Set(tr.checks.filter((c) => !c.passed).map((c) => (c.kind === "invariant" ? `broke ${quoted(rules.get(c.id) ?? c.id)}` : esc(c.detail))))].join("; ")}.`;
  return `<div class="conv">${tr.events.map(said).join("")}<p class="${tr.passed ? "okt" : "badt"}"><b>${verdict}</b></p></div>`;
}

function args(a: unknown): string {
  if (!a || typeof a !== "object") return "";
  return Object.entries(a as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(", ");
}

const graded = (t: TaskSummary) => t.graded ?? t.trials.length;
const passedEvery = (t: TaskSummary) => graded(t) > 0 && t.passes === graded(t);
/** What a scenario is called on the page: its description without a final period, else its id. */
const name = (t: TaskSummary) => (t.description ?? t.id).replace(/\.$/, "");

function result(t: TaskSummary): string {
  const g = graded(t);
  if (g === 0) return `<span class="meta">not graded</span>`;
  const skipped = t.skipped ? ` <span class="meta">(${t.skipped} not graded)</span>` : "";
  return t.passes === g ? `<span class="okt">passed ${g === 1 ? "its conversation" : `all ${g}`}</span>${skipped}` : `<span class="badt">passed ${t.passes} of ${g}</span>${skipped}`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function quoted(s: string): string {
  return `“${esc(s)}”`;
}

/** A quote from the customer's document, with its Markdown bold and code kept. Escaped first, so nothing else becomes markup. */
function inline(s: string): string {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
