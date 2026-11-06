import type { JudgedCounts } from "../judge/summary.ts";
import { comparisonOf, type Comparison, type TaskChange } from "../run/compare.ts";
import { skippedTrials, tagsBelowFloor, type SuiteResult, type TaskSummary } from "../run/suite.ts";
import { formatPercent } from "./terminal.ts";

/**
 * A run's summary in Markdown, for a CI job summary or a pull request comment, from results.json alone. Everything in it
 * that a run holds is escaped: ids and tags come from a domain file, and failure details and verdicts from a model and
 * a transcript. A GitHub comment holds 65,536 characters, so each list has a cap and a character budget: past either,
 * it ends with how many more there are. Escaping can make text four times as long, and the budgets allow for that, so
 * the whole summary stays under the limit whatever a run holds.
 */

/** A list longer than this goes in a `<details>` block. */
const LONG = 10;
/** What a run holds is cut to this before it's escaped, so no cut leaves half of an escape behind. */
const CELL = 200;
/** Each list's cap in rows, and in characters once escaped. */
const CAPS = {
  floors: { rows: 30, chars: 2_000 },
  differences: { rows: 10, chars: 2_000 },
  moved: { rows: 100, chars: 8_000 },
  failed: { rows: 100, chars: 16_000 },
  modes: { rows: 8, chars: 3_000 },
  soft: { rows: 30, chars: 3_000 },
  criteria: { rows: 30, chars: 3_000 },
  verdicts: { rows: 30, chars: 6_000 },
};
/** A list of ids within a line stops at this many characters, after its first id. */
const NAMES_CHARS = 1_000;

const clip = (s: string, width = CELL) => (s.length <= width ? s : `${s.slice(0, width - 1)}…`);

/**
 * Text a run holds, on one line, so that it renders as itself: it can't break a table, open a tag or a link, and can't
 * notify anyone, link an issue or a site, or set math in a comment.
 */
function escapeMarkdown(s: string): string {
  // As entities, not backslashes: a renderer that ignores a backslash there would still see a tag.
  const entities = clip(String(s).replace(/\s*[\r\n]+\s*/g, " "))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return entities.replace(/[\\`*_{}[\]()#+!|~@:$]/g, "\\$&").replace(/\b(www)\./gi, "$1\\.");
}

/** An id as code when it can't do anything there, else escaped. */
function code(s: string): string {
  const id = clip(String(s));
  return /^[\w.:/@+=#() -]+$/.test(id) ? `\`${id}\`` : escapeMarkdown(id);
}

/** Ids as code, the first few of them, then how many more. */
function names(ids: readonly string[], most = 5): string {
  const shown: string[] = [];
  let chars = 0;
  for (const id of ids.slice(0, most)) {
    const named = code(id);
    if (shown.length && chars + named.length > NAMES_CHARS) break;
    shown.push(named);
    chars += named.length;
  }
  return `${shown.join(", ")}${ids.length > shown.length ? ` and ${ids.length - shown.length} more` : ""}`;
}

const pct = (x: number | null | undefined) => (typeof x === "number" && !Number.isNaN(x) ? formatPercent(x) : "n/a");
const gradedOf = (t: TaskSummary) => t.graded ?? t.trials.length;
const passedEvery = (t: TaskSummary) => gradedOf(t) > 0 && t.passes === gradedOf(t);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "(−1.0 pts)" or "(no change)" at the precision percentages are shown, or nothing without both. */
function moved(before: number | null | undefined, after: number | null | undefined): string {
  if (typeof before !== "number" || typeof after !== "number" || Number.isNaN(before) || Number.isNaN(after)) return "";
  const pts = ((after - before) * 100).toFixed(1);
  return Number(pts) === 0 ? "no change" : pts.startsWith("-") ? `−${pts.slice(1)} pts` : `+${pts} pts`;
}

/** As many of `rows` as the cap allows, in order, then how many more there are. */
function capped(rows: readonly string[], cap: { rows: number; chars: number }): string[] {
  let shown = 0;
  let chars = 0;
  while (shown < rows.length && shown < cap.rows && chars + rows[shown]!.length <= cap.chars) chars += rows[shown++]!.length;
  return [...rows.slice(0, shown), ...(shown < rows.length ? ["", `and ${rows.length - shown} more; see report.html`] : [])];
}

/** A capped list under its heads, in a toggle when there are many. */
function listed(head: string[], rows: string[], cap: { rows: number; chars: number }, summary: string): string[] {
  const body = [...head, ...capped(rows, cap)];
  return rows.length > LONG ? ["<details>", `<summary>${summary}</summary>`, "", ...body, "", "</details>"] : body;
}

const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
const heads = (...cells: string[]) => [row(cells), `|${cells.map(() => "---").join("|")}|`];

/** The opening bullets: the scores, and what could make them not the whole story. */
function headline(r: SuiteResult): string[] {
  const hats = Object.entries(r.passHat)
    .filter(([j]) => j === "1" || j === String(r.k))
    .map(([j, v]) => `**pass^${j}** ${pct(v)}`);
  const lines = [`- ${hats.join(" · ")}`];
  if (r.pendingReview?.length) lines.unshift(`- **Provisional:** ${r.pendingReview.length} drafted item(s) are pending review`);
  const critical = r.tasks.filter((t) => t.critical);
  if (critical.length) {
    const failed = critical.filter((t) => !passedEvery(t));
    lines.push(`- **Critical tasks:** ${critical.length - failed.length} of ${critical.length} passed every trial${failed.length ? `; these did not: ${names(failed.map((t) => t.id), 10)}` : ""}`);
  }
  const skipped = skippedTrials(r).length;
  if (skipped) lines.push(`- **Skipped trials:** ${skipped} of ${r.tasks.reduce((n, t) => n + t.trials.length, 0)} ended in an error and are left out of the scores`);
  const below = new Set(tagsBelowFloor(r).map((t) => t.tag));
  const floors = Object.entries(r.floors ?? {}).map(([tag, floor]) => `- **Floor** ${code(tag)} ${pct(floor)}: ${below.has(tag) ? "**not met**" : "met"} (pass^${r.k} ${pct(r.byTag.find((t) => t.tag === tag)?.passHatK)})`);
  return [...lines, ...capped(floors, CAPS.floors)];
}

/** A stored timestamp, which sandtable wrote: as it is unless the file was edited by hand. */
const stamp = (s: string) => (/^[\dT:.Z-]+$/.test(s) ? s : escapeMarkdown(s));

/** The changes listed task by task, in the order a comparison sorts them. */
const LISTED: readonly TaskChange[] = ["broken", "worse", "fixed", "better", "changed"];

/** What changed since the baseline, as `compare` prints it: broken tasks first, then pass^1 and pass^k before and after. */
function changes(c: Comparison): string[] {
  const b = c.baseline;
  const lines = ["### Changes since the baseline", "", `Compared with run ${code(b.runId)}, started ${stamp(b.startedAt)}.`];
  if (c.differences.length) lines.push("", ...capped(c.differences.map((d) => `- ${escapeMarkdown(d)}`), CAPS.differences));
  const shifted = c.tasks.filter((d) => LISTED.includes(d.change));
  const frac = (x?: { passes: number; trials: number }) => (x ? `${x.passes}/${x.trials}` : "–");
  if (shifted.length) {
    const counts = LISTED.flatMap((change) => {
      const n = shifted.filter((d) => d.change === change).length;
      return n ? [`${n} ${change}`] : [];
    });
    const rows = shifted.map((d) => row([`${d.change}${d.what?.length ? ` (${d.what.join(", ")})` : ""}`, code(d.id), frac(d.before), frac(d.after)]));
    lines.push("", ...listed(heads("Change", "Task", "Baseline", "Now"), rows, CAPS.moved, `${plural(shifted.length, "task")} moved: ${counts.join(", ")}`));
  }
  const count = (change: TaskChange) => c.tasks.filter((d) => d.change === change).length;
  const failing = c.tasks.filter((d) => d.change === "added" && d.after!.passes < d.after!.trials).length;
  const others = [
    count("added") ? `${count("added")} added${failing ? `, ${failing} failing` : ""}` : "",
    count("removed") ? `${count("removed")} only in the baseline` : "",
    count("skipped") ? `${count("skipped")} not graded in one of the runs` : "",
    count("same") ? `${count("same")} unchanged` : "",
  ].filter(Boolean);
  if (others.length) lines.push("", others.join(" · "));
  lines.push("");
  if (c.shared === 0) lines.push("No task ran in both runs, so there is no pass^k to compare.");
  else if (c.comparable === 0) lines.push("Every task both runs ran has a changed test, so there is no pass^k to compare.");
  else {
    const left = c.shared - c.comparable;
    if (left) lines.push(`Over the ${plural(c.comparable, "task")} both runs ran with the same test (${left} changed left out):`, "");
    else if (!c.sameTasks) lines.push(`Over the ${plural(c.comparable, "task")} both runs ran:`, "");
    for (const p of c.passHat.filter((p) => p.j === 1 || p.j === c.passHat.length)) lines.push(`- **pass^${p.j}** ${pct(p.before)} → ${pct(p.after)} (${moved(p.before, p.after) || "n/a"})`);
  }
  return lines;
}

/** The tasks that failed a trial, critical ones first, each with its failed check ids. */
function failedTasks(r: SuiteResult): string[] {
  const failed = r.tasks.filter((t) => gradedOf(t) > 0 && t.passes < gradedOf(t));
  if (!failed.length) return [];
  const ordered = [...failed.filter((t) => t.critical), ...failed.filter((t) => !t.critical)];
  const rows = ordered.map((t) => {
    const checks = [...new Set(t.trials.filter((tr) => !tr.skipped).flatMap((tr) => tr.checks.filter((c) => !c.passed).map((c) => c.id)))];
    return row([`${code(t.id)}${t.critical ? " (critical)" : ""}`, `${t.passes}/${gradedOf(t)}${t.passes > 0 ? " flaky" : ""}`, names(checks)]);
  });
  return ["### Failed tasks", "", ...listed(heads("Task", "Passed", "Failed checks"), rows, CAPS.failed, plural(failed.length, "failed task"))];
}

function failureModes(r: SuiteResult): string[] {
  if (!r.failureModes.length) return [];
  const rows = r.failureModes.slice(0, CAPS.modes.rows).map((m) => row([`${m.count}×`, `${escapeMarkdown(m.kind)} ${code(m.id)}`, String(m.tasks.length), escapeMarkdown(m.example)]));
  return ["### Top failure modes", "", ...listed(heads("Count", "Check", "Tasks", "Example"), rows, CAPS.modes, "Top failure modes")];
}

function softRules(r: SuiteResult): string[] {
  const soft = r.soft ?? [];
  if (!soft.length) return [];
  const rows = soft.map((x) => {
    if (x.rate === null) return row([code(x.id), "no rate", x.tool === undefined ? "the agent never spoke" : `no trial called ${code(x.tool)}`]);
    return row([code(x.id), pct(x.rate), `${x.broken} of ${x.applied} ${x.tool === undefined ? "trials" : `trials that called ${code(x.tool)}`}`]);
  });
  return ["### Soft rules", "", "Reported, never fail a trial.", "", ...listed(heads("Rule", "Rate", "Broken in"), rows, CAPS.soft, plural(soft.length, "soft rule"))];
}

const tally = (c: JudgedCounts) => [`${c.pass} pass`, `${c.fail} fail`, ...(c.notApplicable ? [`${c.notApplicable} not applicable`] : [])].join(", ");

/** The judged score, apart from pass^k and labelled as a model's judgement, with the verdicts that failed. */
function judgedScore(r: SuiteResult): string[] {
  const j = r.judged;
  if (!j) return [];
  const lines = ["### Judged score", "", "A model's judgement, apart from pass^k: it never changes pass/fail, pass^k, a gate or an exit code.", ""];
  const by = j.models.length ? `, by ${names(j.models)}` : "";
  lines.push(`**judged** ${pct(j.score)}: ${tally(j)}${j.notJudged ? `, ${j.notJudged} not judged` : ""}${by}`, "");
  const rows = j.criteria.map((c) => row([`${code(c.id)}${c.pending ? " (pending review)" : ""}`, pct(c.score), tally(c)]));
  lines.push(...listed(heads("Criterion", "Score", "Verdicts"), rows, CAPS.criteria, plural(j.criteria.length, "criterion", "criteria")));
  // Only a pass or a fail moves the score. "Provisional" means the run's own pendingReview, which a criterion isn't in.
  const resting = j.criteria.filter((c) => c.pending && c.pass + c.fail > 0).map((c) => c.id);
  if (resting.length) lines.push("", `This score rests on ${plural(resting.length, "criterion", "criteria")} still pending review: ${names(resting)}`);
  const callsFailed = r.tasks.flatMap((t) => t.trials).filter((tr) => tr.judged?.error !== undefined).length;
  if (callsFailed) lines.push("", callsFailed === 1 ? "1 trial's judge call failed, so it isn't in the score." : `${callsFailed} trials' judge calls failed, so they aren't in the score.`);
  const failed = r.tasks.flatMap((t) =>
    t.trials.flatMap((tr) =>
      (tr.judged?.verdicts ?? [])
        .filter((v) => v.verdict === "fail")
        .map((v) => `- ${code(t.id)} trial ${tr.trial + 1}, ${code(v.id)}: ${escapeMarkdown(v.reason)}${v.quote ? ` “${escapeMarkdown(v.quote)}”` : ""}${v.quoteFound === false ? " (this quote isn't in the transcript)" : ""}`),
    ),
  );
  if (failed.length) {
    // Always behind a toggle: what a model said, for whoever wants to read why.
    lines.push("", "<details>", `<summary>${plural(failed.length, "failed verdict")}</summary>`, "", ...capped(failed, CAPS.verdicts), "", "</details>");
  }
  return lines;
}

/** How the judged score moved since the baseline, by criterion: no regression, and apart from the task changes. */
function judgedChanges(c: Comparison): string[] {
  const j = c.judged;
  if (!j) return [];
  const score = (x?: JudgedCounts) => (x === undefined ? "–" : pct(x.score));
  const rows = j.criteria.map((d) =>
    row([code(d.id), score(d.before), score(d.after), moved(d.before?.score, d.after?.score), d.after === undefined ? "only in the baseline" : d.before === undefined ? "only in this run" : d.textDiffers ? "text differs" : ""]),
  );
  const lines = [
    "### Judged score since the baseline",
    "",
    "A model's judgement: never a regression, and it changes no gate or exit code.",
    "",
    ...heads("Criterion", "Baseline", "Now", "Change", "Note"),
    row(["**judged**", score(j.before), score(j.after), moved(j.before?.score, j.after?.score), ""]),
    ...capped(rows, CAPS.criteria),
  ];
  const reworded = j.criteria.filter((d) => d.textDiffers).map((d) => d.id);
  const notes = [
    reworded.length ? `The text of ${names(reworded)} differs between the two runs: a date from \`\${today}\` under \`clock: now\` differs from day to day, and otherwise the criterion was reworded.` : "",
    j.before && j.after && j.before.models.join() !== j.after.models.join() ? `${names(j.before.models)} judged the baseline and ${names(j.after.models)} this run, and another model can score differently.` : "",
    j.before && j.after && !c.sameTasks ? "Each score is over its own run's tasks." : "",
  ].filter(Boolean);
  return notes.length ? [...lines, "", ...notes.map((n) => `- ${n}`)] : lines;
}

function footer(r: SuiteResult): string {
  const written = r.sandtable?.version ? ` ${escapeMarkdown(r.sandtable.version)}` : "";
  const regraded = r.sandtable?.regradedWith ? `, regraded with ${escapeMarkdown(r.sandtable.regradedWith)}` : "";
  return `Written by [sandtable-ai](https://github.com/sandtable-ai/sandtable)${written}${regraded}.`;
}

/** The run's summary, ending with a newline. */
export function renderMarkdown(r: SuiteResult): string {
  const comparison = comparisonOf(r);
  const sections = [
    [`### sandtable · ${code(r.domain)} · agent ${code(r.agent)} · user ${code(r.user)} · k=${r.k}`],
    headline(r),
    comparison ? changes(comparison) : [],
    failedTasks(r),
    failureModes(r),
    softRules(r),
    judgedScore(r),
    comparison ? judgedChanges(comparison) : [],
    [footer(r)],
  ].filter((s) => s.length);
  return `${sections.map((s) => s.join("\n")).join("\n\n")}\n`;
}
