import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { freightScriptedAgent } from "../src/demo/freight-agents.ts";
import { lintDomain } from "../src/grade/lint.ts";
import { formatPercent, renderTerminal } from "../src/report/terminal.ts";
import { runSuite, type SuiteResult } from "../src/run/suite.ts";
import { httpAgent } from "../src/sim/http.ts";
import { noopAgent } from "../src/sim/noop.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import type { AgentAdapter } from "../src/sim/types.ts";
import { loadDomain } from "../src/spec/load.ts";
import type { Domain } from "../src/spec/schema.ts";

// The README, the docs and the examples' READMEs quote numbers and terminal output from offline runs
// of the bundled examples. These tests recompute both. When an example changes, they fail with one
// list of every page to update and what it should say now.

const read = (file: string) => readFileSync(path.resolve(file), "utf8");
const run = (domain: Domain, agent: AgentAdapter) => runSuite({ domain, agent, user: scriptedUser() });
const passes = (r: SuiteResult) => r.tasks.reduce((n, t) => n + t.passes, 0);
const failures = (r: SuiteResult, id: string) => r.failureModes.find((m) => m.id === id)?.count ?? 0;
const writes = (d: Domain) => lintDomain(d).tasks.filter((t) => t.expectsWrite).length;
const cli = async (...args: string[]) => (await promisify(execFile)(process.execPath, [path.resolve("src/cli.ts"), ...args])).stdout;

/** The same text with any other numbers in it: finds what a page says instead of a quote. */
const anyNumbers = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\d+(?:\\\.\d+)?/g, "\\d+(?:\\.\\d+)?");
const squash = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").trim().replace(/\s+/g, " ");

const HINT = "These pages quote the bundled examples, which changed. Update each line as shown";

/** One line per quote the text lacks, saying what it says instead when only the numbers differ. */
function missing(where: string, text: string, quotes: string[]): string[] {
  return quotes
    .filter((q) => !text.includes(q))
    .map((q) => {
      const now = new RegExp(anyNumbers(q)).exec(text)?.[0];
      return now ? `${where}: replace "${now}" with "${q}"` : `${where}: should say "${q}" (if its wording changed on purpose, change the quote in test/docs.test.ts)`;
    });
}

/** One line per line of the quoted output block that the command no longer prints. "..." skips lines. */
function staleOutput(file: string, anchor: string, command: string, output: string): string[] {
  const block = [...read(file).matchAll(/```text\n([\s\S]*?)```/g)].map((m) => m[1]!).find((b) => b.includes(anchor));
  if (!block) return [`${file}: no text block contains "${anchor}" any more (change test/docs.test.ts if the page moved it)`];
  const printed = output.split("\n").map(squash);
  return block
    .split("\n")
    .map(squash)
    .filter((line) => line && line !== "..." && !line.startsWith("$ ") && !printed.includes(line))
    .map((line) => {
      const now = printed.find((p) => new RegExp(`^${anyNumbers(line)}$`).test(p));
      return now ? `${file}: replace "${line}" with "${now}"` : `${file}: \`${command}\` no longer prints "${line}"`;
    });
}

/**
 * A fetch that answers like the quickstart's toy HTTP agent: the page's agent-server.mjs, run as the
 * page shows it, with `createServer` handed in instead of imported. Each POST goes straight to the
 * page's request handler, so no server listens and nothing touches the network.
 */
function quickstartAgentFetch(): typeof fetch {
  const code = /^[ \t]*```js agent-server\.mjs\n([\s\S]*?)^[ \t]*```/m.exec(read("docs/quickstart.mdx"))?.[1];
  if (!code) throw new Error("docs/quickstart.mdx has no ```js agent-server.mjs block any more (change test/docs.test.ts if the page renamed it)");
  const imports = [...code.matchAll(/^\s*import .*$/gm)].map((m) => m[0].trim());
  expect(imports, "the toy agent may import only createServer: the test hands it in").toEqual(['import { createServer } from "node:http";']);
  type Handler = (req: Iterable<string>, res: { setHeader(): void; end(body: string): void }) => Promise<void>;
  let handler: Handler | undefined;
  new Function("createServer", code.replace(/^\s*import .*$/gm, ""))((h: Handler) => {
    handler = h;
    return { listen: () => {} };
  });
  if (!handler) throw new Error("the quickstart's toy agent no longer calls createServer(handler)");
  const serve = handler;
  return async (_url, init) => new Response(await new Promise<string>((end) => void serve([String(init?.body)], { setHeader() {}, end })));
}

let freight: Domain;
let clinic: Domain;
let naive: SuiteResult;
let careful: SuiteResult;
let noop: SuiteResult;
let toy: SuiteResult;

beforeAll(async () => {
  freight = await loadDomain(path.resolve("examples/freight"));
  clinic = await loadDomain(path.resolve("examples/clinic"));
  vi.stubGlobal("fetch", quickstartAgentFetch());
  try {
    [naive, careful, noop, toy] = await Promise.all([
      run(freight, freightScriptedAgent("naive")),
      run(freight, freightScriptedAgent("careful")),
      run(freight, noopAgent()),
      run(freight, httpAgent("http://localhost:8787/step")),
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("pages that quote the bundled examples", () => {
  it("the careful freight agent passes every task, as the pages say", () => {
    expect(passes(careful)).toBe(freight.tasks.length);
  });

  it("quote today's numbers", () => {
    const n = freight.tasks.length;
    const counts = `${Object.keys(freight.world.tables).length} tables, ${freight.tools.length} tools, ${freight.invariants.length} invariants`;
    const naive1 = formatPercent(naive.passHat["1"]!);
    const noop1 = formatPercent(noop.passHat["1"]!);
    const card = `On the same ${n} scripted freight calls, a naive agent scores pass^1 ${naive1}, with ${failures(naive, "verify-before-book")} calls breaking verify-before-book, ${failures(naive, "rate-ceiling")} rate-ceiling and ${failures(naive, "eligible-carrier")} eligible-carrier`;
    const pages: Record<string, string[]> = {
      "README.md": [
        `passes ${passes(naive)} of ${n} calls`,
        `${failures(naive, "verify-before-book")} calls booked without vetting the carrier`,
        `${failures(naive, "rate-ceiling")} booked above the load's rate ceiling`,
        `${failures(naive, "eligible-carrier")} booked a carrier that may not be booked`,
        `passes all ${n}`,
        `the same ${n} scripted calls`,
        `(${n} tasks, ${freight.invariants.length} invariants)`,
        `(a clinic front desk, ${clinic.tasks.length} tasks, ${clinic.invariants.length} invariants)`,
      ],
      "docs/quickstart.mdx": [
        `replay ${n} scripted carrier calls`,
        `scores pass^1 ${naive1} (${passes(naive)} of ${n})`,
        // The page's toy HTTP agent, the noop baseline, and each task the toy agent passes that noop fails.
        `It scores pass^1 ${formatPercent(toy.passHat["1"]!)} (${passes(toy)} of ${n})`,
        `never calls a tool, scores ${noop1} (${passes(noop)} of ${n})`,
        ...toy.tasks.filter((t) => t.passes > noop.tasks.find((x) => x.id === t.id)!.passes).map((t) => `\`${t.id}\``),
      ],
      "docs/concepts/baselines.mdx": [
        `it scores **${Math.round(noop.passHat["1"]! * 100)}%**`,
        `noop gets ${Math.round(noop.byTag.find((t) => t.tag === "refusal")!.passHat1 * 100)}% on \`refusal\``,
      ],
      "docs/concepts/domain.mdx": [`${counts} and ${n} tasks`, `with ${clinic.tasks.length} tasks and ${clinic.invariants.length} invariants`],
      "docs/guides/claude-code-plugin.mdx": [`The noop baseline scores \`pass^1 ${noop1}\``, `asked to, scores \`pass^1 ${naive1}\``],
      "examples/freight/README.md": [`${n} rehearsed calls: ${writes(freight)} must end with a write, ${n - writes(freight)} must not`],
      "examples/clinic/README.md": [
        `${clinic.tools.length} tools, ${clinic.invariants.length} invariants`,
        `${clinic.tasks.length} rehearsed calls: ${writes(clinic)} must end with a write`,
        `, ${clinic.tasks.length - writes(clinic)} must not`,
      ],
    };
    const metatags = (JSON.parse(read("docs/docs.json")) as { seo: { metatags: Record<string, string> } }).seo.metatags;
    const problems = [
      ...Object.entries(pages).flatMap(([file, quotes]) => missing(file, read(file), quotes)),
      ...["og:image:alt", "twitter:image:alt"].flatMap((tag) => missing(`docs/docs.json ${tag}`, metatags[tag] ?? "", [card])),
    ];
    expect(problems, HINT).toEqual([]);
  });

  it.skipIf(!process.features.typescript)("quote today's terminal output", { timeout: 30_000 }, async () => {
    const [lint, validate] = await Promise.all([cli("lint", "examples/freight"), cli("validate", "examples/freight")]);
    const problems = [
      ...staleOutput("docs/index.mdx", "$ sandtable demo", "sandtable demo", renderTerminal(naive)),
      ...staleOutput("docs/concepts/baselines.mdx", "agent noop · user scripted", "sandtable run examples/freight --agent noop --user scripted", renderTerminal(noop)),
      ...staleOutput("docs/concepts/baselines.mdx", "$ sandtable lint examples/freight", "sandtable lint examples/freight", lint),
      ...staleOutput("docs/guides/claude-code-plugin.mdx", "Top failure modes", "sandtable run examples/freight --agent scripted:naive --user scripted", renderTerminal(naive)),
      ...staleOutput("docs/guides/claude-code-plugin.mdx", "✓ book-then-quick-pay-handoff", "sandtable lint examples/freight", lint),
      ...staleOutput("docs/reference/cli.mdx", "✓ freight-carrier-sales:", "sandtable validate examples/freight", validate),
    ];
    expect(problems, HINT).toEqual([]);
  });
});
