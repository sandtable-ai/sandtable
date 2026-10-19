#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import { clinicScriptedAgent } from "./demo/clinic-agents.ts";
import { freightScriptedAgent } from "./demo/freight-agents.ts";
import { formatPercent, renderTerminal } from "./report/terminal.ts";
import { renderHtml } from "./report/html.ts";
import { everyTrialFailed, runSuite, type SuiteResult } from "./run/suite.ts";
import { claudeAgent, claudeUser, type ClaudeOptions, type Provider } from "./sim/claude.ts";
import { registerPrices } from "./run/usage.ts";
import { bedrockConverseAgent } from "./sim/bedrock-converse.ts";
import { httpAgent } from "./sim/http.ts";
import { noopAgent } from "./sim/noop.ts";
import { DEFAULT_OPENAI_BASE_URL, openaiCompatAgent, openaiCompatUser, type OpenAICompatOptions } from "./sim/openai-compat.ts";
import { scriptedUser } from "./sim/scripted.ts";
import type { AgentAdapter, UserSimulator } from "./sim/types.ts";
import { appendRows, appendToDomainList } from "./init/merge.ts";
import { draftFromOpenApi } from "./init/openapi.ts";
import { draftInvariantsFromSop, knownFields } from "./init/sop.ts";
import { draftTasksFromTranscripts } from "./init/transcripts.ts";
import { DOMAIN_FILE, POLICY_PLACEHOLDER, renderDraft, TASKS_PLACEHOLDER, writeDraft } from "./init/render.ts";
import { DomainError, loadDomain, pendingReview } from "./spec/load.ts";
import { lintDomain } from "./grade/lint.ts";
import { renderLeaderboardMarkdown, runLeaderboard } from "./run/leaderboard.ts";
import { z } from "zod";
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

interface ProviderFlags {
  provider?: Provider;
  region?: string;
  awsProfile?: string;
}

const providerOpts = (o: ProviderFlags): ClaudeOptions => ({
  ...(o.provider ? { provider: o.provider } : {}),
  ...(o.region ? { region: o.region } : {}),
  ...(o.awsProfile ? { awsProfile: o.awsProfile } : {}),
});

function withProviderFlags(cmd: Command): Command {
  return cmd
    .option("--provider <name>", "where Claude runs: anthropic | bedrock (default: SANDTABLE_PROVIDER or anthropic)")
    .option("--region <region>", "AWS region for --provider bedrock (default: AWS_REGION)")
    .option("--aws-profile <name>", "AWS profile for --provider bedrock (default: AWS_PROFILE)");
}

/**
 * Endpoint for an `openai:<model>` spec. The key comes from OPENAI_API_KEY, the usual convention
 * for OpenAI-compatible servers; local servers such as Ollama and vLLM need none.
 */
function openaiEndpoint(spec: string, baseUrlFlag?: string): OpenAICompatOptions {
  const model = spec.slice("openai:".length);
  if (!model) throw new Error(`"${spec}" names no model: use openai:<model>, e.g. openai:gpt-4.1-mini`);
  const baseUrl = baseUrlFlag || process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey && baseUrl.startsWith(DEFAULT_OPENAI_BASE_URL)) {
    throw new Error(`${spec} on ${baseUrl} needs OPENAI_API_KEY (or point --openai-base-url at another endpoint)`);
  }
  return { baseUrl, model, ...(apiKey ? { apiKey } : {}) };
}

async function resolveAgent(spec: string, p: ClaudeOptions = {}, openaiBaseUrl?: string): Promise<AgentAdapter> {
  if (spec === "noop") return noopAgent();
  if (spec === "claude") return claudeAgent(p);
  if (spec.startsWith("claude:")) return claudeAgent({ ...p, model: spec.slice("claude:".length) });
  if (spec.startsWith("bedrock:")) {
    return bedrockConverseAgent({
      modelId: spec.slice("bedrock:".length),
      ...(p.region ? { region: p.region } : {}),
      ...(p.awsProfile ? { awsProfile: p.awsProfile } : {}),
    });
  }
  if (spec.startsWith("openai:")) return openaiCompatAgent(openaiEndpoint(spec, openaiBaseUrl));
  if (/^https?:\/\//.test(spec)) return httpAgent(spec);
  if (spec === "scripted:naive" || spec === "scripted:careful") return freightScriptedAgent(spec.endsWith("naive") ? "naive" : "careful");
  if (spec === "scripted:clinic-naive" || spec === "scripted:clinic-careful") return clinicScriptedAgent(spec.endsWith("naive") ? "naive" : "careful");
  const mod = (await import(pathToFileURL(path.resolve(spec)).href)) as { default?: unknown };
  const exported = typeof mod.default === "function" ? await (mod.default as () => unknown)() : mod.default;
  if (!exported || typeof (exported as AgentAdapter).createSession !== "function") {
    throw new Error(`${spec} must default-export an AgentAdapter (or a function returning one)`);
  }
  return exported as AgentAdapter;
}

function resolveUser(spec: string, p: ClaudeOptions = {}, openaiBaseUrl?: string): UserSimulator {
  if (spec === "scripted") return scriptedUser();
  if (spec === "claude") return claudeUser(p);
  if (spec.startsWith("claude:")) return claudeUser({ ...p, model: spec.slice("claude:".length) });
  if (spec.startsWith("openai:")) return openaiCompatUser(openaiEndpoint(spec, openaiBaseUrl));
  throw new Error(`unknown user simulator "${spec}" (use claude, claude:<model>, openai:<model> or scripted)`);
}

async function save(result: SuiteResult, outDir: string, html: boolean): Promise<string> {
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "results.json"), JSON.stringify(result, null, 2));
  if (html) await writeFile(path.join(outDir, "report.html"), renderHtml(result));
  return outDir;
}

/** Open a file in the default browser; best effort, never fails the run. */
function openInBrowser(file: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [file]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", file]] : ["xdg-open", [file]];
  try {
    spawn(cmd, args as string[], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  } catch {
    // no browser available (CI, containers): the path is printed anyway
  }
}

/** A run where every trial ended in an error graded nothing: say so and exit 1, whatever the score. */
function failIfNothingGraded(result: SuiteResult): boolean {
  const error = everyTrialFailed(result);
  if (error === undefined) return false;
  console.error(`\n✗ Every trial ended in an error, so this run says nothing about the agent. The first error:\n  ${error}`);
  process.exitCode = 1;
  return true;
}

async function loadPrices(file?: string): Promise<void> {
  if (!file) return;
  const added = registerPrices(JSON.parse(await readFile(file, "utf8")));
  console.log(`  prices: ${added.length} model(s) from ${file}`);
}

function defaultOut(label: string): string {
  return path.join(".sandtable", "runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}`);
}

// package.json sits one level above both src/cli.ts and dist/cli.js, and ships in the npm package.
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const program = new Command()
  .name("sandtable")
  .description("Rehearse an AI agent on a simulated copy of a customer's world before it goes live.")
  .version(version);

withProviderFlags(program
  .command("init"))
  .description("draft a domain from a customer's artifacts (review the output before trusting it)")
  .option("--openapi <file>", "OpenAPI 3.x spec (YAML or JSON): drafts tables and tools, no model needed")
  .option("--sop <file>", "SOP / policy document: drafts invariants with Claude, each quoting its source")
  .option("--transcripts <path>", "call/chat transcripts (a file or a directory of .txt/.md): drafts personas and tasks with Claude")
  .option("-o, --out <dir>", "domain directory to create, or to add to when it already exists", "sandtable")
  .option("-m, --model <id>", "Claude model for drafting steps")
  .option("--force", "overwrite existing files when drafting from --openapi")
  .action(async (o: { openapi?: string; sop?: string; transcripts?: string; out: string; model?: string; force?: boolean } & ProviderFlags) => {
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
        claude: { ...providerOpts(o), ...(o.model ? { model: o.model } : {}) },
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
      const res = await draftTasksFromTranscripts({
        domain: await loadDomain(o.out),
        transcripts,
        claude: { ...providerOpts(o), ...(o.model ? { model: o.model } : {}) },
      });
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

withProviderFlags(program
  .command("run"))
  .argument("<domain>", "domain directory (with sandtable.yaml) or file")
  .description("run every task k times against an agent and grade the results")
  .option("-a, --agent <spec>", "claude | claude:<model> | bedrock:<model-id> | openai:<model> | noop | http(s)://endpoint | ./my-agent.js", "claude")
  .option("-u, --user <spec>", "simulated user: claude | claude:<model> | openai:<model> | scripted", "claude")
  .option("--openai-base-url <url>", `OpenAI-compatible endpoint for openai:<model> (default: OPENAI_BASE_URL or ${DEFAULT_OPENAI_BASE_URL}); key from OPENAI_API_KEY`)
  .option("-k, --trials <n>", "trials per task (pass^k is reported up to k)", int, 1)
  .option("-t, --tasks <ids>", "comma-separated task ids to run")
  .option("-c, --concurrency <n>", "episodes in parallel", int, 4)
  .option("-o, --out <dir>", "output directory for results.json and report.html")
  .option("--no-html", "skip the HTML report")
  .option("--fail-under <pct>", "exit 1 if pass^k is below this percentage (CI gate)", percent)
  .option("--open", "open the HTML report in the browser when the run finishes")
  .option("--prices <file>", "extra model prices (JSON from scripts/bedrock-prices.mjs, or { model: {input, output, cacheRead, cacheWrite} })")
  .action(async (domainPath: string, o: { agent: string; user: string; openaiBaseUrl?: string; trials: number; tasks?: string; concurrency: number; out?: string; html: boolean; failUnder?: number; open?: boolean; prices?: string } & ProviderFlags) => {
    await loadPrices(o.prices);
    const domain = await loadDomain(domainPath);
    if (domain.tasks.length === 0) throw new Error(`${domain.name} has no tasks yet: add some to tasks.yaml`);
    const agent = await resolveAgent(o.agent, providerOpts(o), o.openaiBaseUrl);
    const user = resolveUser(o.user, providerOpts(o), o.openaiBaseUrl);
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
    if (failIfNothingGraded(result)) return;
    if (o.open && o.html) openInBrowser(path.join(out, "report.html"));
    const score = result.passHat[String(o.trials)] ?? 0;
    if (o.failUnder !== undefined && !(score >= o.failUnder)) {
      console.error(`\n✗ pass^${o.trials} ${formatPercent(score)} is below --fail-under ${formatPercent(o.failUnder)}`);
      process.exitCode = 1;
    }
  });

const ModelsFile = z
  .object({
    user: z.string().optional(),
    k: z.number().int().positive().optional(),
    models: z.array(z.object({ label: z.string(), agent: z.string() }).strict()).min(1),
  })
  .strict();

withProviderFlags(program
  .command("leaderboard"))
  .argument("<domain>", "domain directory (with sandtable.yaml) or file")
  .description("rank several agents on one domain under the same simulated users, plus a do-nothing baseline")
  .requiredOption("-m, --models <file>", "YAML file: { user?, k?, models: [{ label, agent }] } (agent specs as in `run --agent`)")
  .option("-u, --user <spec>", "simulated user for every model (overrides the models file; default claude)")
  .option("-k, --trials <n>", "trials per task (overrides the models file; default 4)", int)
  .option("-t, --tasks <ids>", "comma-separated task ids to run, for every model and the baseline")
  .option("-c, --concurrency <n>", "episodes in parallel per model", int, 4)
  .option("--openai-base-url <url>", "OpenAI-compatible endpoint for openai:<model> entries")
  .option("-o, --out <dir>", "output directory (default: leaderboard/<domain name>)")
  .option("--no-resume", "rerun models even when matching results already exist")
  .option("--prices <file>", "extra model prices (JSON from scripts/bedrock-prices.mjs)")
  .action(async (domainPath: string, o: { models: string; user?: string; trials?: number; tasks?: string; concurrency: number; openaiBaseUrl?: string; out?: string; resume: boolean; prices?: string } & ProviderFlags) => {
    await loadPrices(o.prices);
    const domain = await loadDomain(domainPath);
    const parsed = ModelsFile.safeParse(YAML.parse(await readFile(o.models, "utf8")));
    if (!parsed.success) throw new Error(`${o.models}:\n${z.prettifyError(parsed.error)}`);
    const cfg = parsed.data;
    const p = providerOpts(o);
    const user = resolveUser(o.user ?? cfg.user ?? "claude", p, o.openaiBaseUrl);
    const k = o.trials ?? cfg.k ?? 4;
    const out = o.out ?? path.join("leaderboard", domain.name);
    const taskIds = o.tasks?.split(",").map((s) => s.trim()).filter(Boolean);
    const tasks = taskIds?.length ? taskIds.length : domain.tasks.length;
    console.log(`Leaderboard: ${cfg.models.length} model(s) on ${domain.name} (${tasks} tasks, k=${k}, caller ${user.name})\n`);
    const mark = { cached: "↺ cached ", ran: "✓ ran    ", failed: "✗ failed ", skipped: "- skipped" } as const;
    const result = await runLeaderboard({
      domain,
      entries: cfg.models,
      user,
      k,
      ...(taskIds?.length ? { taskIds } : {}),
      outDir: out,
      concurrency: o.concurrency,
      resume: o.resume,
      resolveAgent: (spec) => resolveAgent(spec, p, o.openaiBaseUrl),
      onEntry: (label, status, note) => console.log(`  ${mark[status]}  ${label}${note ? `  (${note})` : ""}`),
    });
    console.log(`\n${renderLeaderboardMarkdown(result)}`);
    console.log(`  ${path.join(out, "leaderboard.html")}`);
  });

withProviderFlags(program
  .command("demo"))
  .description("rehearse the bundled freight carrier-sales example")
  .option("--live", "use Claude as both the agent and the simulated user (needs ANTHROPIC_API_KEY or `ant auth login`)")
  .option("-k, --trials <n>", "trials per task in --live mode", int, 2)
  .option("--agent-model <id>", "model for the agent in --live mode")
  .option("--user-model <id>", "model for the simulated caller in --live mode (a cheaper model keeps runs cheap)")
  .option("--no-open", "do not open the HTML report in the browser")
  .action(async (o: { live?: boolean; trials: number; agentModel?: string; userModel?: string; open: boolean } & ProviderFlags) => {
    const shouldOpen = o.open && process.stdout.isTTY;
    const domain = await loadDomain(EXAMPLE);
    if (o.live) {
      const p = providerOpts(o);
      const result = await runSuite({
        domain,
        agent: claudeAgent({ ...p, ...(o.agentModel ? { model: o.agentModel } : {}) }),
        user: claudeUser({ ...p, ...(o.userModel ? { model: o.userModel } : {}) }),
        k: o.trials,
      });
      console.log(renderTerminal(result));
      const out = await save(result, defaultOut("demo-live"), true);
      console.log(`\n  report: ${path.join(out, "report.html")}`);
      if (failIfNothingGraded(result)) return;
      if (shouldOpen) openInBrowser(path.join(out, "report.html"));
      return;
    }
    console.log("Offline demo: two rule-based agents replay scripted carrier calls. No API key needed.\n");
    let firstReport: string | undefined;
    for (const mode of ["naive", "careful"] as const) {
      const result = await runSuite({ domain, agent: freightScriptedAgent(mode), user: scriptedUser() });
      console.log(renderTerminal(result));
      const out = await save(result, defaultOut(`demo-${mode}`), true);
      firstReport ??= path.join(out, "report.html");
      console.log(`\n  report: ${path.join(out, "report.html")}\n`);
    }
    if (shouldOpen && firstReport) openInBrowser(firstReport);
    console.log("Next:");
    console.log("  sandtable demo --live                                  Claude plays the carrier and the agent (k=2)");
    console.log("  sandtable init --openapi api.yaml --sop sop.md -o mine  draft a domain from your customer's docs");
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
