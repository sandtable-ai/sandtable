#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import { freightScriptedAgent } from "./demo/freight-agents.ts";
import { formatPercent, renderTerminal } from "./report/terminal.ts";
import { renderHtml } from "./report/html.ts";
import { everyTrialFailed, runSuite, type SuiteResult } from "./run/suite.ts";
import { changedVerdicts, RegradeError, regradeSuite } from "./run/regrade.ts";
import { writeFileAtomic } from "./run/write.ts";
import { claudeAgent, claudeUser, providerOf, type ClaudeOptions, type Provider } from "./sim/claude.ts";
import { registerPrices } from "./run/usage.ts";
import { DEFAULT_OPENAI_BASE_URL } from "./sim/openai-compat.ts";
import { scriptedUser } from "./sim/scripted.ts";
import { leaderboardAgent, resolveAgent, resolveUser } from "./sim/resolve.ts";
import { appendRows, appendToDomainList } from "./init/merge.ts";
import { draftFromOpenApi, openApiProblem } from "./init/openapi.ts";
import { draftInvariantsFromSop, knownFields } from "./init/sop.ts";
import { draftTasksFromTranscripts } from "./init/transcripts.ts";
import { DOMAIN_FILE, isPolicyPlaceholder, POLICY_PLACEHOLDER, renderDraft, TASKS_PLACEHOLDER, writeDraft } from "./init/render.ts";
import { DomainError, domainWarnings, loadDomain, pendingReview } from "./spec/load.ts";
import { lintDomain } from "./grade/lint.ts";
import { bedrockRegion, bedrockUse, ModelsFile, pricesFile, renderLeaderboardMarkdown, runLeaderboard, type PricesFile, type RunInfo } from "./run/leaderboard.ts";
import { z } from "zod";
import YAML from "yaml";

// A reader that stops early (`| head`, `less` quit before the end) closes the pipe: stop quietly with 141,
// the status a shell reports for a Unix tool killed by SIGPIPE (128 + 13), instead of crashing with an EPIPE
// stack trace. Node ignores SIGPIPE, so the CLI exits with that status itself. Any other write error still crashes.
const SIGPIPE_STATUS = 141;
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(SIGPIPE_STATUS);
    throw err;
  });
}

// The examples ship in the npm package, one level above both src/cli.ts and dist/cli.js.
const BUNDLED_EXAMPLES = fileURLToPath(new URL("../examples/", import.meta.url));
const EXAMPLE = path.join(BUNDLED_EXAMPLES, "freight");

/**
 * The domain path to load. The docs and skills run `examples/freight` and `examples/clinic`, which
 * exist relative to the current directory only in a clone. When the path is missing and names a
 * bundled example, use the copy shipped in the package, and say where it is.
 */
async function resolveDomain(p: string): Promise<string> {
  if (await stat(p).catch(() => undefined)) return p;
  const name = /^(?:\.\/)?examples\/([\w-]+)\/?$/.exec(p.replaceAll("\\", "/"))?.[1];
  if (!name) return p;
  const bundled = path.join(BUNDLED_EXAMPLES, name);
  if (!(await stat(path.join(bundled, "sandtable.yaml")).catch(() => undefined))) return p;
  console.error(`(no ${p} in this directory: using the copy bundled with sandtable-ai, ${bundled})`);
  return bundled;
}

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

const PRICES_HELP = "extra model prices, JSON in USD per million tokens: { \"<model-id>\": { input, output, cacheRead, cacheWrite } } (the sandtable repo's scripts/bedrock-prices.mjs writes one for Bedrock)";

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

async function save(result: SuiteResult, outDir: string, html: boolean): Promise<string> {
  await mkdir(outDir, { recursive: true });
  await writeFileAtomic(path.join(outDir, "results.json"), JSON.stringify(result, null, 2));
  if (html) await writeFileAtomic(path.join(outDir, "report.html"), renderHtml(result));
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

/** Parse a results.json written by `run`, or say what the file is not. */
function parseResults(text: string, file: string): SuiteResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const r = data as Partial<SuiteResult> | null;
  if (!r || typeof r !== "object" || !Array.isArray(r.tasks) || typeof r.passHat !== "object" || typeof r.domain !== "string") {
    throw new Error(`${file} is not a results.json written by \`sandtable run\` (a leaderboard has one per model, in its folder)`);
  }
  return r as SuiteResult;
}

async function loadPrices(file?: string): Promise<PricesFile | undefined> {
  if (!file) return undefined;
  const bytes = await readFile(file);
  const added = registerPrices(JSON.parse(bytes.toString("utf8")));
  console.log(`  prices: ${added.length} model(s) from ${file}`);
  // Real paths on both sides, so a symlinked working directory (macOS /var -> /private/var) still reads as inside.
  return pricesFile(await realpath(file), bytes, await realpath(process.cwd()));
}

// Printed next steps use `npx sandtable-ai`: every way of installing sandtable needs Node.js and npm
// (the PyPI launcher runs npx itself), so the line runs as written for every user.
const NEXT = "npx sandtable-ai";

function defaultOut(label: string): string {
  return path.join(".sandtable", "runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}`);
}

// package.json sits one level above both src/cli.ts and dist/cli.js, and ships in the npm package.
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

/**
 * The commit sandtable runs from, when it runs from its own git clone. An npm install inside someone's
 * repository is not a clone of sandtable, so its commit is never recorded.
 */
function sandtableCommit(): { commit?: string; dirty?: boolean } {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    if (path.resolve(git("rev-parse", "--show-toplevel")) !== path.resolve(root)) return {};
    return { commit: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--untracked-files=no") !== "" };
  } catch {
    return {};
  }
}

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
      const problem = openApiProblem(spec);
      if (problem) throw new Error(`${o.openapi} ${problem}. Nothing was written.`);
      const draft = draftFromOpenApi(spec);
      if (draft.tools.length === 0) {
        throw new Error([`${o.openapi}: no operation could be drafted into a tool, so nothing was written.`, ...draft.warnings.map((w) => `  ! ${w}`)].join("\n"));
      }
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
      if (isPolicyPlaceholder(currentPolicy)) await writeFile(policyFile, sopText);
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
    console.log(`\nNext: accept or fix each drafted item, then validate:\n  ${NEXT} review ${o.out}\n  ${NEXT} validate ${o.out} --strict`);
  });

program
  .command("validate")
  .argument("<domain>", "domain directory (with sandtable.yaml) or file")
  .description("check a domain spec for schema and cross-reference errors")
  .option("--strict", "also fail while drafted items are pending review")
  .action(async (domainPath: string, o: { strict?: boolean }) => {
    const d = await loadDomain(await resolveDomain(domainPath));
    console.log(`✓ ${d.name}: ${Object.keys(d.world.tables).length} tables, ${d.tools.length} tools, ${d.invariants.length} invariants, ${d.tasks.length} tasks`);
    for (const w of domainWarnings(d)) console.log(`⚠ ${w}`);
    const pending = pendingReview(d);
    if (pending.length) {
      console.log(`⚠ ${pending.length} drafted item(s) pending review (${NEXT} review ${domainPath})`);
      if (o.strict) process.exitCode = 1;
    }
  });

program
  .command("lint")
  .argument("<domain>", "domain directory (with sandtable.yaml) or file")
  .description("prove every task is ready, solvable, non-vacuous and graded, without any model call")
  .action(async (domainPath: string) => {
    const report = lintDomain(await loadDomain(await resolveDomain(domainPath)));
    for (const t of report.tasks) {
      const solvable = t.solvable === null ? "solvable ?" : t.solvable ? "solvable" : "NOT solvable";
      const kind = t.expectsWrite ? "write" : "no-write";
      const mark = t.errors.length ? "✗" : t.warnings.length ? "!" : "✓";
      console.log(`${mark} ${t.id}  (${kind} · ${t.ready ? "ready" : "NOT ready"} · ${solvable} · noop ${t.noopPasses ? "passes" : "fails"})`);
      for (const e of t.errors) console.log(`    ✗ ${e}`);
      for (const w of t.warnings) console.log(`    ! ${w}`);
    }
    const noWrite = report.tasks.filter((t) => !t.expectsWrite).length;
    const noopPasses = report.tasks.filter((t) => t.noopPasses).length;
    console.log(`\n${report.tasks.length} tasks: ${report.tasks.length - noWrite} expect a write, ${noWrite} do not; a do-nothing agent passes ${noopPasses} of ${report.tasks.length}.`);
    console.log(`${report.errors} error(s), ${report.warnings} warning(s)`);
    if (report.errors) process.exitCode = 1;
  });

program
  .command("review")
  .argument("<domain>", "domain directory (with sandtable.yaml) or file")
  .description("list drafted items that still need a person to accept them")
  .action(async (domainPath: string) => {
    const pending = pendingReview(await loadDomain(await resolveDomain(domainPath)));
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
  .option("-a, --agent <spec>", "claude | claude:<model> | bedrock:<model-id> | openai:<model> | noop | http(s)://endpoint | ./my-agent.js | scripted:naive, scripted:careful, scripted:clinic-naive, scripted:clinic-careful (rule-based demo agents for the bundled examples)", "claude")
  .option("-u, --user <spec>", "simulated user: claude | claude:<model> | openai:<model> | scripted", "claude")
  .option("--openai-base-url <url>", `OpenAI-compatible endpoint for openai:<model> (default: OPENAI_BASE_URL or ${DEFAULT_OPENAI_BASE_URL}); key from OPENAI_API_KEY`)
  .option("-k, --trials <n>", "trials per task (pass^k is reported up to k)", int, 1)
  .option("-t, --tasks <ids>", "comma-separated task ids to run")
  .option("-c, --concurrency <n>", "episodes in parallel", int, 4)
  .option("-o, --out <dir>", "output directory for results.json and report.html")
  .option("--no-html", "skip the HTML report")
  .option("--fail-under <pct>", "exit 1 if pass^k is below this percentage (CI gate)", percent)
  .option("--open", "open the HTML report in the browser when the run finishes")
  .option("--prices <file>", PRICES_HELP)
  .action(async (domainPath: string, o: { agent: string; user: string; openaiBaseUrl?: string; trials: number; tasks?: string; concurrency: number; out?: string; html: boolean; failUnder?: number; open?: boolean; prices?: string } & ProviderFlags) => {
    await loadPrices(o.prices);
    const domain = await loadDomain(await resolveDomain(domainPath));
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

withProviderFlags(program
  .command("leaderboard"))
  .argument("<domain>", "domain directory (with sandtable.yaml) or file")
  .description("rank several agents on one domain under the same simulated users, plus a do-nothing baseline")
  // Commander's help doesn't mark a required option, so the usage line and the description say it.
  .usage("<domain> -m <file> [options]")
  .requiredOption("-m, --models <file>", "(required) YAML file: { user?, k?, models: [{ label, agent, effort? }] } (agent specs as in `run --agent`; effort low|medium|high|xhigh|max, for claude: agents only)")
  .option("-u, --user <spec>", "simulated user for every model (overrides the models file; default claude)")
  .option("-k, --trials <n>", "trials per task (overrides the models file; default 4)", int)
  .option("-t, --tasks <ids>", "comma-separated task ids to run, for every model and the baseline")
  .option("-c, --concurrency <n>", "episodes in parallel per model", int, 4)
  .option("--openai-base-url <url>", "OpenAI-compatible endpoint for openai:<model> entries")
  .option("-o, --out <dir>", "output directory (default: leaderboard/<domain name>)")
  .option("--no-resume", "rerun every model and replace its stored results")
  .option("--prices <file>", PRICES_HELP)
  .action(async (domainPath: string, o: { models: string; user?: string; trials?: number; tasks?: string; concurrency: number; openaiBaseUrl?: string; out?: string; resume: boolean; prices?: string } & ProviderFlags) => {
    const prices = await loadPrices(o.prices);
    const domain = await loadDomain(await resolveDomain(domainPath));
    const parsed = ModelsFile.safeParse(YAML.parse(await readFile(o.models, "utf8")));
    if (!parsed.success) throw new Error(`${o.models}:\n${z.prettifyError(parsed.error)}`);
    const cfg = parsed.data;
    const userSpec = o.user ?? cfg.user ?? "claude";
    const flags = providerOpts(o);
    const uses = bedrockUse([userSpec, ...cfg.models.map((m) => m.agent)], providerOf(flags));
    const region = uses.bedrock ? await bedrockRegion(flags.region, flags.awsProfile) : undefined;
    // Without one, every Bedrock model would look stale and rerun against the SDK's default region.
    if (uses.bedrock && !region) throw new Error("no AWS region for Bedrock: pass --region, or set AWS_REGION or a region in the AWS profile");
    // With no --region or AWS_REGION, the Claude Bedrock SDK falls back to us-east-1 and the AWS SDK to the
    // profile's config. Give every adapter the one region run.json records, so it says where the calls went.
    const p: ClaudeOptions = region ? { ...flags, region } : flags;
    const user = resolveUser(userSpec, p, o.openaiBaseUrl);
    const k = o.trials ?? cfg.k ?? 4;
    const out = o.out ?? path.join("leaderboard", domain.name);
    const taskIds = o.tasks?.split(",").map((s) => s.trim()).filter(Boolean);
    const tasks = taskIds?.length ? taskIds.length : domain.tasks.length;
    const runInfo: RunInfo = {
      sandtable: { version, ...sandtableCommit() },
      ...(uses.claude ? { provider: providerOf(p) } : {}),
      ...(region ? { region } : {}),
    };
    console.log(`Leaderboard: ${cfg.models.length} model(s) on ${domain.name} (${tasks} tasks, k=${k}, caller ${user.name})\n`);
    if (runInfo.sandtable.dirty) console.log("  ! the sandtable checkout has uncommitted changes: run.json records the commit, not them\n");
    const mark = { cached: "↺ cached  ", regraded: "↻ regraded", ran: "✓ ran     ", failed: "✗ failed  ", skipped: "- skipped " } as const;
    const result = await runLeaderboard({
      domain,
      entries: cfg.models,
      user,
      k,
      ...(taskIds?.length ? { taskIds } : {}),
      outDir: out,
      concurrency: o.concurrency,
      resume: o.resume,
      runInfo,
      userSpec,
      ...(prices ? { prices } : {}),
      resolveAgent: (spec, effort) => leaderboardAgent(spec, effort, p, o.openaiBaseUrl),
      onEntry: (label, status, note) => console.log(`  ${mark[status]}  ${label}${note ? `  (${note})` : ""}`),
    });
    console.log(`\n${renderLeaderboardMarkdown(result)}`);
    console.log(`  ${path.join(out, "leaderboard.html")}`);
    // A board on which every model failed ranks nothing, whatever the baseline did. A board of noop
    // entries only has no model rows: nothing failed, and the baseline it asked for ran.
    const models = result.rows.filter((r) => !r.baseline);
    if (models.length > 0 && models.every((r) => r.error !== undefined)) {
      console.error(`\n✗ Every model failed, so this board ranks none of them: the ✗ failed lines above give each model's error (missing credentials or package, the wrong provider or region, throttling, an agent that isn't running).`);
      process.exitCode = 1;
    }
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
    console.log("  Claude on both sides, Haiku as the cheaper caller (needs ANTHROPIC_API_KEY):");
    console.log(`    ${NEXT} demo --live --user-model claude-haiku-5-5`);
    console.log("  Draft a domain from your customer's API spec and SOP:");
    console.log(`    ${NEXT} init --openapi api.yaml --sop sop.md -o mine`);
  });

program
  .command("report")
  .argument("<results>", "path to a results.json")
  .description("re-render the HTML report for a past run")
  .option("-o, --out <file>", "output HTML path (default: next to results.json)")
  .action(async (resultsPath: string, o: { out?: string }) => {
    const result = parseResults(await readFile(resultsPath, "utf8"), resultsPath);
    const out = o.out ?? path.join(path.dirname(resultsPath), "report.html");
    await writeFile(out, renderHtml(result));
    console.log(out);
  });

program
  .command("regrade")
  .argument("<results>", "path to a results.json")
  .description("re-score a past run's stored trials under the domain's current rules, without calling a model")
  // results.json records only the domain's name, so the domain itself is always given. Commander's help
  // doesn't mark a required option, so the usage line and the description say it.
  .usage("<results> -d <dir> [options]")
  .requiredOption("-d, --domain <dir>", "(required) the domain the run used, as edited since: a directory (with sandtable.yaml) or the file itself")
  .option("-o, --out <dir>", "output directory for results.json and report.html (default: the results' own directory, replacing them)")
  .option("--no-html", "skip the HTML report")
  .action(async (resultsPath: string, o: { domain: string; out?: string; html: boolean }) => {
    const stored = parseResults(await readFile(resultsPath, "utf8"), resultsPath);
    const domain = await loadDomain(await resolveDomain(o.domain));
    let result: SuiteResult;
    try {
      result = regradeSuite(domain, stored);
    } catch (err) {
      if (!(err instanceof RegradeError)) throw err;
      // A run of another domain: the fix is usually the --domain the run used, unless the domain was renamed since.
      if (stored.domain !== domain.name) {
        throw new Error(
          `can't regrade ${resultsPath}: it is a run of ${stored.domain}, not ${domain.name}, so --domain ${o.domain} is likely not the domain the run used. Pass the one whose sandtable.yaml has \`name: ${stored.domain}\`, the name results.json records as "domain". If you renamed the domain since the run, restore its \`name:\` or rerun it with \`npx sandtable-ai run\`.`,
        );
      }
      throw new Error(`can't regrade ${resultsPath}: ${err.message}. Rerun it with \`npx sandtable-ai run\` instead.`);
    }
    const flipped = changedVerdicts(stored, result);
    console.log(renderTerminal(result));
    const trials = result.tasks.reduce((n, t) => n + t.trials.length, 0);
    console.log(`\n  regraded ${trials} trial(s) without calling a model: ${flipped.length} verdict(s) changed`);
    for (const tr of flipped) console.log(`    ${tr.passed ? "✗ → ✓" : "✓ → ✗"}  ${tr.taskId} trial ${tr.trial + 1}`);
    for (const j of [...new Set(["1", String(result.k)])]) {
      if (stored.passHat[j] !== result.passHat[j]) console.log(`  pass^${j} ${formatPercent(stored.passHat[j] ?? 0)} → ${formatPercent(result.passHat[j] ?? 0)}`);
    }
    const out = await save(result, o.out ?? path.dirname(resultsPath), o.html);
    console.log(`\n  results: ${path.join(out, "results.json")}${o.html ? `\n  report:  ${path.join(out, "report.html")}` : ""}`);
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof DomainError ? `Invalid domain: ${err.message}` : err instanceof Error ? err.message : err);
  process.exit(1);
});
