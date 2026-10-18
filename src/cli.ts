#!/usr/bin/env node
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import { freightScriptedAgent } from "./demo/freight-agents.ts";
import { formatPercent, renderTerminal } from "./report/terminal.ts";
import { renderHtml } from "./report/html.ts";
import { runSuite, type SuiteResult } from "./run/suite.ts";
import { claudeAgent, claudeUser } from "./sim/claude.ts";
import { httpAgent } from "./sim/http.ts";
import { noopAgent } from "./sim/noop.ts";
import { scriptedUser } from "./sim/scripted.ts";
import type { AgentAdapter, UserSimulator } from "./sim/types.ts";
import { appendRows, appendToDomainList } from "./init/merge.ts";
import { draftFromOpenApi } from "./init/openapi.ts";
import { draftInvariantsFromSop, knownFields } from "./init/sop.ts";
import { draftTasksFromTranscripts } from "./init/transcripts.ts";
import { DOMAIN_FILE, POLICY_PLACEHOLDER, renderDraft, TASKS_PLACEHOLDER, writeDraft } from "./init/render.ts";
import { DomainError, loadDomain, pendingReview } from "./spec/load.ts";
import { lintDomain } from "./grade/lint.ts";
import YAML from "yaml";

const EXAMPLE = fileURLToPath(new URL("../examples/freight", import.meta.url));

const int = (v: string) => {
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("must be a positive integer");
  return n;
};
const percent = (v: string) => {
  const n = Number(v.replace("%", ""));
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new InvalidArgumentError("must be 0-100");
  return n / 100;
};

async function resolveAgent(spec: string): Promise<AgentAdapter> {
  if (spec === "noop") return noopAgent();
  if (spec === "claude") return claudeAgent();
  if (spec.startsWith("claude:")) return claudeAgent({ model: spec.slice("claude:".length) });
  if (/^https?:\/\//.test(spec)) return httpAgent(spec);
  if (spec === "scripted:naive" || spec === "scripted:careful") return freightScriptedAgent(spec.endsWith("naive") ? "naive" : "careful");
  const mod = (await import(pathToFileURL(path.resolve(spec)).href)) as { default?: unknown };
  const exported = typeof mod.default === "function" ? await (mod.default as () => unknown)() : mod.default;
  if (!exported || typeof (exported as AgentAdapter).createSession !== "function") {
    throw new Error(`${spec} must default-export an AgentAdapter (or a function returning one)`);
  }
  return exported as AgentAdapter;
}

function resolveUser(spec: string): UserSimulator {
  if (spec === "scripted") return scriptedUser();
  if (spec === "claude") return claudeUser();
  if (spec.startsWith("claude:")) return claudeUser({ model: spec.slice("claude:".length) });
  throw new Error(`unknown user simulator "${spec}" (use claude, claude:<model> or scripted)`);
}

async function save(result: SuiteResult, outDir: string, html: boolean): Promise<string> {
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "results.json"), JSON.stringify(result, null, 2));
  if (html) await writeFile(path.join(outDir, "report.html"), renderHtml(result));
  return outDir;
}

function defaultOut(label: string): string {
  return path.join(".sandtable", "runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}`);
}

const program = new Command()
  .name("sandtable")
  .description("Rehearse an AI agent on a simulated copy of a customer's world before it goes live.")
  .version("0.1.0-alpha.0");

program
  .command("init")
  .description("draft a domain from a customer's artifacts (review the output before trusting it)")
  .option("--openapi <file>", "OpenAPI 3.x spec (YAML or JSON): drafts tables and tools, no model needed")
  .option("--sop <file>", "SOP / policy document: drafts invariants with Claude, each quoting its source")
  .option("--transcripts <path>", "call/chat transcripts (a file or a directory of .txt/.md): drafts personas and tasks with Claude")
  .option("-o, --out <dir>", "domain directory to create, or to add to when it already exists", "sandtable")
  .option("-m, --model <id>", "Claude model for drafting steps")
  .option("--force", "overwrite existing files when drafting from --openapi")
  .action(async (o: { openapi?: string; sop?: string; transcripts?: string; out: string; model?: string; force?: boolean }) => {
    if (!o.openapi && !o.sop && !o.transcripts) throw new Error("pass at least one of --openapi, --sop, --transcripts");
    const sopText = o.sop ? await readFile(o.sop, "utf8") : undefined;
    let fields: Record<string, string[]> = {};
    if (o.openapi) {
      const spec = YAML.parse(await readFile(o.openapi, "utf8")) as Record<string, unknown>;
      const draft = draftFromOpenApi(spec);
      fields = Object.fromEntries(Object.entries(draft.tables).map(([n, t]) => [n, t.fields]));
      const files = {
        [DOMAIN_FILE]: renderDraft(draft, path.basename(o.openapi)),
        "policy.md": sopText ?? POLICY_PLACEHOLDER,
        "tasks.yaml": TASKS_PLACEHOLDER,
      };
      const written = await writeDraft(o.out, files, o.force);
      const notes = draft.tools.reduce((n, t) => n + t.notes.length, 0);
      console.log(`Drafted ${draft.name}: ${Object.keys(draft.tables).length} tables, ${draft.tools.length} tools, ${notes} review notes.`);
      for (const w of draft.warnings) console.log(`  ! ${w}`);
      for (const f of written) console.log(`  wrote ${f}`);
    }
    if (o.sop && sopText !== undefined) {
      const domain = await loadDomain(o.out);
      const policyFile = path.join(o.out, "policy.md");
      const currentPolicy = await readFile(policyFile, "utf8").catch(() => undefined);
      if (currentPolicy === POLICY_PLACEHOLDER) await writeFile(policyFile, sopText);
      console.log(`Drafting invariants from ${o.sop}...`);
      const res = await draftInvariantsFromSop({
        domain,
        sop: sopText,
        sopFile: path.basename(o.sop),
        fields: knownFields(domain, fields),
        claude: o.model ? { model: o.model } : {},
      });
      const soft = res.softRules.map((r) => ` Soft rule (not checkable from tool calls yet): ${r.rule}\n   "${r.quote}"`).join("\n");
      const file = await appendToDomainList(o.out, "invariants", res.invariants, soft || undefined);
      console.log(`  ${res.invariants.length} invariant(s) drafted (review: pending), ${res.softRules.length} soft rule(s) noted in ${file}`);
      for (const w of res.warnings) console.log(`  ! ${w}`);
    }
    if (o.transcripts) {
      const files = (await stat(o.transcripts)).isDirectory()
        ? (await readdir(o.transcripts)).filter((f) => /\.(txt|md)$/i.test(f)).sort().map((f) => path.join(o.transcripts!, f))
        : [o.transcripts];
      const transcripts = await Promise.all(files.map(async (f) => ({ file: path.basename(f), text: await readFile(f, "utf8") })));
      console.log(`Drafting tasks from ${transcripts.length} transcript(s) (PII scrubbed locally first)...`);
      const res = await draftTasksFromTranscripts({ domain: await loadDomain(o.out), transcripts, claude: o.model ? { model: o.model } : {} });
      if (Object.keys(res.rows).length) await appendRows(o.out, res.rows);
      if (res.personas.length) await appendToDomainList(o.out, "personas", res.personas);
      if (res.tasks.length) await appendToDomainList(o.out, "tasks", res.tasks);
      const rows = Object.values(res.rows).reduce((n, r) => n + r.length, 0);
      console.log(`  ${res.tasks.length} task(s), ${res.personas.length} persona(s), ${rows} seed row(s) drafted; ${res.redactions} PII redaction(s)`);
      for (const w of res.warnings) console.log(`  ! ${w}`);
    }
    console.log(`\nNext: sandtable review ${o.out}, accept or fix each item, then sandtable validate ${o.out} --strict`);
  });

program
  .command("validate")
  .argument("<domain>", "domain directory (with sandtable.yaml) or file")
  .description("check a domain spec for schema and cross-reference errors")
  .option("--strict", "also fail while drafted items are pending review")
  .action(async (domainPath: string, o: { strict?: boolean }) => {
    const d = await loadDomain(domainPath);
    console.log(`✓ ${d.name}: ${Object.keys(d.world.tables).length} tables, ${d.tools.length} tools, ${d.invariants.length} invariants, ${d.tasks.length} tasks`);
    const pending = pendingReview(d);
    if (pending.length) {
      console.log(`⚠ ${pending.length} drafted item(s) pending review (sandtable review ${domainPath})`);
      if (o.strict) process.exitCode = 1;
    }
  });

program
  .command("lint")
  .argument("<domain>", "domain directory (with sandtable.yaml) or file")
  .description("prove every task is ready, solvable, non-vacuous and graded, without any model call")
  .action(async (domainPath: string) => {
    const report = lintDomain(await loadDomain(domainPath));
    for (const t of report.tasks) {
      const solvable = t.solvable === null ? "solvable ?" : t.solvable ? "solvable" : "NOT solvable";
      const kind = t.expectsWrite ? "write" : "no-write";
      const mark = t.errors.length ? "✗" : t.warnings.length ? "!" : "✓";
      console.log(`${mark} ${t.id}  (${kind} · ${t.ready ? "ready" : "NOT ready"} · ${solvable} · noop ${t.noopPasses ? "passes" : "fails"})`);
      for (const e of t.errors) console.log(`    ✗ ${e}`);
      for (const w of t.warnings) console.log(`    ! ${w}`);
    }
    const noWrite = report.tasks.filter((t) => !t.expectsWrite).length;
    console.log(`\n${report.tasks.length} tasks: ${report.tasks.length - noWrite} expect a write, ${noWrite} do not (the noop baseline passes those by design).`);
    console.log(`${report.errors} error(s), ${report.warnings} warning(s)`);
    if (report.errors) process.exitCode = 1;
  });

program
  .command("review")
  .argument("<domain>", "domain directory (with sandtable.yaml) or file")
  .description("list drafted items that still need a person to accept them")
  .action(async (domainPath: string) => {
    const pending = pendingReview(await loadDomain(domainPath));
    if (!pending.length) return console.log("Nothing pending review.");
    for (const p of pending) {
      console.log(`- ${p.kind} ${p.id}${p.source ? `  (${p.source.file})` : ""}`);
      if (p.source?.quote) console.log(`    "${p.source.quote}"`);
      if (p.kind === "tool") console.log("    see the TODO(review) comments above it in sandtable.yaml");
    }
    console.log(`\nAccept an item by changing its \`review: pending\` to \`review: accepted\` (or deleting the line).`);
  });

program
  .command("run")
  .argument("<domain>", "domain directory (with sandtable.yaml) or file")
  .description("run every task k times against an agent and grade the results")
  .option("-a, --agent <spec>", "claude | claude:<model> | noop | http(s)://endpoint | ./my-agent.js", "claude")
  .option("-u, --user <spec>", "simulated user: claude | claude:<model> | scripted", "claude")
  .option("-k, --trials <n>", "trials per task (pass^k is reported up to k)", int, 1)
  .option("-t, --tasks <ids>", "comma-separated task ids to run")
  .option("-c, --concurrency <n>", "episodes in parallel", int, 4)
  .option("-o, --out <dir>", "output directory for results.json and report.html")
  .option("--no-html", "skip the HTML report")
  .option("--fail-under <pct>", "exit 1 if pass^k is below this percentage (CI gate)", percent)
  .action(async (domainPath: string, o: { agent: string; user: string; trials: number; tasks?: string; concurrency: number; out?: string; html: boolean; failUnder?: number }) => {
    const domain = await loadDomain(domainPath);
    if (domain.tasks.length === 0) throw new Error(`${domain.name} has no tasks yet: add some to tasks.yaml`);
    const agent = await resolveAgent(o.agent);
    const user = resolveUser(o.user);
    let done = 0;
    const total = (o.tasks ? o.tasks.split(",").length : domain.tasks.length) * o.trials;
    const result = await runSuite({
      domain,
      agent,
      user,
      k: o.trials,
      concurrency: o.concurrency,
      taskIds: o.tasks?.split(",").map((s) => s.trim()).filter(Boolean),
      onTrial: (r) => {
        done++;
        if (process.stderr.isTTY) process.stderr.write(`\r  ${done}/${total} trials  ${r.passed ? "✓" : "✗"} ${r.taskId}`.padEnd(70));
      },
    });
    if (process.stderr.isTTY) process.stderr.write("\r".padEnd(72) + "\r");
    console.log(renderTerminal(result));
    const out = await save(result, o.out ?? defaultOut(domain.name), o.html);
    console.log(`\n  results: ${path.join(out, "results.json")}${o.html ? `\n  report:  ${path.join(out, "report.html")}` : ""}`);
    const score = result.passHat[String(o.trials)] ?? 0;
    if (o.failUnder !== undefined && !(score >= o.failUnder)) {
      console.error(`\n✗ pass^${o.trials} ${formatPercent(score)} is below --fail-under ${formatPercent(o.failUnder)}`);
      process.exitCode = 1;
    }
  });

program
  .command("demo")
  .description("rehearse the bundled freight carrier-sales example")
  .option("--live", "use Claude as both the agent and the simulated user (needs ANTHROPIC_API_KEY or `ant auth login`)")
  .option("-k, --trials <n>", "trials per task in --live mode", int, 2)
  .action(async (o: { live?: boolean; trials: number }) => {
    const domain = await loadDomain(EXAMPLE);
    if (o.live) {
      const result = await runSuite({ domain, agent: claudeAgent(), user: claudeUser(), k: o.trials });
      console.log(renderTerminal(result));
      const out = await save(result, defaultOut("demo-live"), true);
      console.log(`\n  report: ${path.join(out, "report.html")}`);
      return;
    }
    console.log("Offline demo: two rule-based agents replay scripted carrier calls. No API key needed.\n");
    for (const mode of ["naive", "careful"] as const) {
      const result = await runSuite({ domain, agent: freightScriptedAgent(mode), user: scriptedUser() });
      console.log(renderTerminal(result));
      const out = await save(result, defaultOut(`demo-${mode}`), true);
      console.log(`\n  report: ${path.join(out, "report.html")}\n`);
    }
    console.log("Next: sandtable demo --live   (Claude plays the carrier and the agent, k=2)");
  });

program
  .command("report")
  .argument("<results>", "path to a results.json")
  .description("re-render the HTML report for a past run")
  .option("-o, --out <file>", "output HTML path (default: next to results.json)")
  .action(async (resultsPath: string, o: { out?: string }) => {
    const result = JSON.parse(await readFile(resultsPath, "utf8")) as SuiteResult;
    const out = o.out ?? path.join(path.dirname(resultsPath), "report.html");
    await writeFile(out, renderHtml(result));
    console.log(out);
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof DomainError ? `Invalid domain: ${err.message}` : err instanceof Error ? err.message : err);
  process.exit(1);
});
