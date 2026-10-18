#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { DomainError, loadDomain } from "./spec/load.ts";

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
  return path.join(".rehearse", "runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}`);
}

const program = new Command()
  .name("rehearse")
  .description("Rehearse an AI agent on a simulated copy of a customer's world before it goes live.")
  .version("0.1.0-alpha.0");

program
  .command("validate")
  .argument("<domain>", "domain directory (with rehearsal.yaml) or file")
  .description("check a domain spec for schema and cross-reference errors")
  .action(async (domainPath: string) => {
    const d = await loadDomain(domainPath);
    console.log(`✓ ${d.name}: ${Object.keys(d.world.tables).length} tables, ${d.tools.length} tools, ${d.invariants.length} invariants, ${d.tasks.length} tasks`);
  });

program
  .command("run")
  .argument("<domain>", "domain directory (with rehearsal.yaml) or file")
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
    console.log("Next: rehearse demo --live   (Claude plays the carrier and the agent, k=2)");
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
