import { execFileSync } from "node:child_process";
import path from "node:path";
import vm from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
import { freightScriptedAgent } from "../src/demo/freight-agents.ts";
import { lintDomain } from "../src/grade/lint.ts";
import { renderHtml } from "../src/report/html.ts";
import { renderTerminal } from "../src/report/terminal.ts";
import { regradeSuite } from "../src/run/regrade.ts";
import { runSuite, type SuiteResult } from "../src/run/suite.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import { loadDomain } from "../src/spec/load.ts";
import { DomainSpec, type Domain } from "../src/spec/schema.ts";

const freightDir = path.resolve("examples/freight");
let freight: Domain;
let careful: SuiteResult;
let naive: SuiteResult;

beforeAll(async () => {
  freight = await loadDomain(freightDir);
  careful = await runSuite({ domain: freight, agent: freightScriptedAgent("careful"), user: scriptedUser() });
  naive = await runSuite({ domain: freight, agent: freightScriptedAgent("naive"), user: scriptedUser() });
});

/** Run the report's script against a stand-in for the page and return the coverage section's HTML. */
function coverageSection(html: string): string {
  const script = html.slice(html.indexOf("<script>") + "<script>".length, html.indexOf("</script>"));
  const elements = new Map<string, { innerHTML: string; textContent: string; scrollIntoView(): void }>();
  const document = {
    getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, { innerHTML: "", textContent: "", scrollIntoView() {} });
      return elements.get(id)!;
    },
  };
  vm.runInContext(script, vm.createContext({ document }));
  return elements.get("coverage")?.innerHTML ?? "";
}

describe("lint: which tasks test each rule", () => {
  it("finds every freight rule checked in some task and every tool used", () => {
    const report = lintDomain(freight);
    expect(report.rules.map((r) => r.id)).toEqual(freight.invariants.map((i) => i.id));
    expect(report.rules.filter((r) => r.warnings.length)).toEqual([]);
    expect(report.unusedTools).toEqual([]);
    expect(report.warnings).toBe(0);
    const tasksOf = Object.fromEntries(report.rules.map((r) => [r.id, r.tasks]));
    // A reference that calls book_load tests every rule on book_load.
    expect(tasksOf["rate-ceiling"]).toContain("book-at-posted-rate");
    // A submission id exists only once submit_offer creates it: the replay's rows count, not just the seed's.
    expect(tasksOf["never-disclose-submission-id"]!.length).toBeGreaterThan(0);
    // The do-not-use reason is shown by the reference's lookup of the flagged carrier.
    expect(tasksOf["never-disclose-dnu-reason"]).toEqual(["do-not-use-carrier", "do-not-use-capacity"]);
    expect(report.tasks.find((t) => t.id === "do-not-use-carrier")!.rules).toContain("never-disclose-dnu-reason");
  });

  it("warns about a rule no task checks, without an error, and lists the tools no task uses", () => {
    const only = freight.tasks.filter((t) => t.id === "book-at-posted-rate");
    const report = lintDomain(DomainSpec.parse({ ...freight, tasks: only }));
    expect(report.errors).toBe(0);
    const warned = Object.fromEntries(report.rules.filter((r) => r.warnings.length).map((r) => [r.id, r.warnings[0]]));
    expect(warned["offer-ceiling"]).toMatch(/no task checks it: no task's reference calls log_offer, and no task's called or not_called names it/);
    expect(warned["never-disclose-dnu-reason"]).toMatch(/no task's reference or context shows the agent a carriers.dnu_reason value/);
    expect(warned["rate-ceiling"]).toBeUndefined();
    expect(report.warnings).toBe(Object.keys(warned).length);
    expect(report.unusedTools).toEqual(expect.arrayContaining(["log_offer", "submit_offer", "log_capacity", "schedule_callback"]));
    expect(report.unusedTools).not.toContain("book_load");
  });

  it("counts a tool named only by not_called, as a refusal task does", () => {
    const refusal = { id: "refuse", tags: [], user: { instructions: "x" }, expect: { state: [], called: [], not_called: ["log_offer"], reply_includes: [] } };
    const report = lintDomain(DomainSpec.parse({ ...freight, tasks: [refusal] }));
    expect(report.rules.find((r) => r.id === "offer-ceiling")!.tasks).toEqual(["refuse"]);
    expect(report.unusedTools).not.toContain("log_offer");
  });

  it("prints the rules checked and the gaps, and still exits 0", () => {
    const out = execFileSync(process.execPath, ["src/cli.ts", "lint", "examples/clinic"], { encoding: "utf8" });
    expect(out).toContain("12 of 12 rules checked in at least one task.");
    expect(out).toContain("Tools no task uses: list_providers");
  });
});

describe("coverage of a run", () => {
  it("records a cell per task that planned or checked a rule, in spec order", () => {
    const rule = careful.coverage!.rules.find((r) => r.id === "rate-ceiling")!;
    expect(rule).toMatchObject({ kind: "limit", tool: "book_load", broken: 0 });
    expect(rule.checked).toBeGreaterThan(0);
    const order = freight.tasks.map((t) => t.id);
    const ids = rule.tasks.map((c) => c.task);
    expect(ids).toEqual([...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    expect(rule.tasks.find((c) => c.task === "book-at-posted-rate")).toEqual({ task: "book-at-posted-rate", planned: true, checked: 1, broken: 0 });
    // A task that never touches book_load has no cell.
    expect(ids).not.toContain("do-not-use-capacity");
  });

  it("finds every rule checked, none broken and every tool called with the careful agent", () => {
    const cov = careful.coverage!;
    expect(cov.rules.filter((r) => r.checked === 0).map((r) => r.id)).toEqual([]);
    expect(cov.rules.every((r) => r.broken === 0)).toBe(true);
    expect(cov.tools.filter((t) => t.calls === 0)).toEqual([]);
    const disclose = cov.rules.find((r) => r.id === "never-disclose-ceiling")!;
    expect(disclose).toMatchObject({ kind: "never_disclose", field: "loads.max_rate" });
    expect(disclose.tool).toBeUndefined();
    // A submission id the run created counts as shown to the agent.
    expect(cov.rules.find((r) => r.id === "never-disclose-submission-id")!.checked).toBeGreaterThan(0);
    expect(cov.rules.find((r) => r.id === "counter-at-ceiling")!.soft).toBe(true);
  });

  it("shows the naive agent's gaps and the rules it broke", () => {
    const cov = naive.coverage!;
    const offer = cov.rules.find((r) => r.id === "offer-ceiling")!;
    expect(offer.checked).toBe(0);
    // Planned by the negotiation tasks' references, though the naive agent never logs an offer.
    expect(offer.tasks.length).toBeGreaterThan(0);
    expect(offer.tasks.every((c) => c.planned && c.checked === 0)).toBe(true);
    const verify = cov.rules.find((r) => r.id === "verify-before-book")!;
    expect(verify.broken).toBeGreaterThan(0);
    expect(verify.broken).toBe(verify.tasks.reduce((n, c) => n + c.broken, 0));
    const broken = naive.tasks.flatMap((t) => t.trials).filter((tr) => tr.violations.some((v) => v.invariant === "verify-before-book")).length;
    expect(verify.broken).toBe(broken);
    expect(cov.tools.find((t) => t.name === "log_offer")).toEqual({ name: "log_offer", trials: 0, calls: 0, tasks: [] });
  });

  it("is added by regrade to results from before coverage", () => {
    const { coverage: _, ...old } = careful;
    const regraded = regradeSuite(freight, old as SuiteResult);
    expect(regraded.coverage).toEqual(careful.coverage);
  });
});

describe("coverage in the reports", () => {
  it("draws the matrix with the gaps outlined and a broken cell that opens its trial", () => {
    const html = coverageSection(renderHtml(naive));
    expect(html).toContain("<h2>Coverage</h2>");
    expect(html).toContain("<span class='chip gapchip'>never checked</span>");
    expect(html).toContain("dot none");
    expect(html).toContain("never called");
    // The first naive task breaks verify-before-book in its only trial: its cell opens trial 0 of task 0.
    expect(html).toMatch(/<button class='dot bad' title='book-at-posted-rate: broken in 1 of 1 trial\(s\), so this task caught it; open the first' onclick='show\(0,0\)'>/);
    const clean = coverageSection(renderHtml(careful));
    expect(clean).toContain("19 of 19 rules checked · 0 caught broken · every tool called.");
    expect(clean).not.toContain("gapchip");
    expect(coverageSection(renderHtml(naive))).toContain("14 of 19 rules checked, 5 never · 10 caught broken · 2 of 9 tools never called.");
  });

  it("leaves the section out for results from before coverage", () => {
    const { coverage: _, ...old } = careful;
    expect(coverageSection(renderHtml(old as SuiteResult))).toBe("");
    expect(renderTerminal(old as SuiteResult)).not.toContain("coverage:");
  });

  it("names the gaps in the terminal summary", () => {
    const out = renderTerminal(naive);
    expect(out).toContain("coverage: 14 of 19 rules checked (10 broken), 2 of 9 tools never called");
    expect(out).toMatch(/never checked \(verify-before-offer, offer-ceiling, /);
    expect(out).toContain("never called (verify_carrier, log_offer)");
    expect(renderTerminal(careful)).toContain("coverage: 19 of 19 rules checked, every tool called");
  });
});
