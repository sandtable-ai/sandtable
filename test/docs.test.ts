import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { freightScriptedAgent } from "../src/demo/freight-agents.ts";
import { lintDomain } from "../src/grade/lint.ts";
import { formatPercent } from "../src/report/terminal.ts";
import { runSuite, type SuiteResult } from "../src/run/suite.ts";
import { noopAgent } from "../src/sim/noop.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import type { AgentAdapter } from "../src/sim/types.ts";
import { loadDomain } from "../src/spec/load.ts";
import type { Domain } from "../src/spec/schema.ts";

// The README and the docs quote numbers from offline runs of the bundled examples. These tests
// recompute them, so a change to an example fails here until the pages say what the code does.

const read = (file: string) => readFileSync(path.resolve(file), "utf8");
const run = (domain: Domain, agent: AgentAdapter) => runSuite({ domain, agent, user: scriptedUser() });
const passes = (r: SuiteResult) => r.tasks.reduce((n, t) => n + t.passes, 0);
const failures = (r: SuiteResult, id: string) => r.failureModes.find((m) => m.id === id)?.count ?? 0;

let freight: Domain;
let clinic: Domain;
let naive: SuiteResult;
let careful: SuiteResult;
let noop: SuiteResult;

beforeAll(async () => {
  freight = await loadDomain(path.resolve("examples/freight"));
  clinic = await loadDomain(path.resolve("examples/clinic"));
  [naive, careful, noop] = await Promise.all([
    run(freight, freightScriptedAgent("naive")),
    run(freight, freightScriptedAgent("careful")),
    run(freight, noopAgent()),
  ]);
});

describe("numbers quoted from the bundled examples", () => {
  it("README", () => {
    const n = freight.tasks.length;
    const text = read("README.md");
    for (const s of [
      `passes ${passes(naive)} of ${n} calls`,
      `${failures(naive, "verify-before-book")} calls booked without vetting the carrier`,
      `${failures(naive, "rate-ceiling")} booked above the load's rate ceiling`,
      `${failures(naive, "eligible-carrier")} booked a carrier that may not be booked`,
      `passes all ${passes(careful)}`,
      `the same ${n} scripted calls`,
      `(${n} tasks, ${freight.invariants.length} invariants)`,
      `(a clinic front desk, ${clinic.tasks.length} tasks, ${clinic.invariants.length} invariants)`,
    ]) expect(text, s).toContain(s);
    expect(passes(careful)).toBe(n);
  });

  it("quickstart", () => {
    const text = read("docs/quickstart.mdx");
    for (const s of [
      `replay ${freight.tasks.length} scripted carrier calls`,
      `scores pass^1 ${formatPercent(naive.passHat["1"]!)} (${passes(naive)} of ${freight.tasks.length})`,
      // The toy HTTP agent never books, so it scores exactly what the noop baseline does.
      `It scores pass^1 ${Math.round(noop.passHat["1"]! * 100)}%: exactly what the [noop baseline]`,
    ]) expect(text, s).toContain(s);
  });

  it("docs.json social card text", () => {
    const text = read("docs/docs.json");
    const s = `On the same ${freight.tasks.length} scripted freight calls, a naive agent scores pass^1 ${formatPercent(naive.passHat["1"]!)}, with ${failures(naive, "verify-before-book")} calls breaking verify-before-book, ${failures(naive, "rate-ceiling")} rate-ceiling and ${failures(naive, "eligible-carrier")} eligible-carrier`;
    expect(text.split(s).length - 1, s).toBe(2);
  });

  it("concept, guide and reference pages", () => {
    const lint = lintDomain(freight);
    const noWrite = lint.tasks.filter((t) => !t.expectsWrite).length;
    const lintLine = `${freight.tasks.length} tasks: ${freight.tasks.length - noWrite} expect a write, ${noWrite} do not; a do-nothing agent passes ${lint.tasks.filter((t) => t.noopPasses).length} of ${freight.tasks.length}.`;
    const counts = `${Object.keys(freight.world.tables).length} tables, ${freight.tools.length} tools, ${freight.invariants.length} invariants`;
    const pages: Record<string, string[]> = {
      "docs/index.mdx": [`pass^1 ${formatPercent(naive.passHat["1"]!)}`, `${failures(naive, "verify-before-book")}× invariant verify-before-book`],
      "docs/concepts/baselines.mdx": [`it scores **${Math.round(noop.passHat["1"]! * 100)}%**`, `pass^1 ${formatPercent(noop.passHat["1"]!)}`, lintLine],
      "docs/concepts/domain.mdx": [`${counts} and ${freight.tasks.length} tasks`, `with ${clinic.tasks.length} tasks and ${clinic.invariants.length} invariants`],
      "docs/reference/cli.mdx": [`✓ ${freight.name}: ${counts}, ${freight.tasks.length} tasks`],
      "docs/guides/claude-code-plugin.mdx": [
        lintLine,
        `The noop baseline scores \`pass^1 ${formatPercent(noop.passHat["1"]!)}\``,
        `scores \`pass^1 ${formatPercent(naive.passHat["1"]!)}\``,
        `${failures(naive, "verify-before-book")}× invariant verify-before-book`,
      ],
    };
    for (const [file, strings] of Object.entries(pages)) {
      const text = read(file);
      for (const s of strings) expect(text, `${file}: ${s}`).toContain(s);
    }
  });
});
