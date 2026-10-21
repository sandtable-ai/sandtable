import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
import { freightScriptedAgent } from "../src/demo/freight-agents.ts";
import { renderHtml } from "../src/report/html.ts";
import { renderTerminal } from "../src/report/terminal.ts";
import { regradeSuite } from "../src/run/regrade.ts";
import { criticalFailures, runSuite, type SuiteResult } from "../src/run/suite.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import { loadDomain } from "../src/spec/load.ts";
import { DomainSpec, type Domain } from "../src/spec/schema.ts";

// A critical task is a release blocker: any failed trial fails `sandtable run`, whatever the score,
// and the reports list critical tasks first.

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tasks = ["book-at-posted-rate", "expired-insurance", "walk-away-above-ceiling", "inactive-authority"];
let freight: Domain;
let naive: SuiteResult;
let careful: SuiteResult;

beforeAll(async () => {
  freight = await loadDomain(path.resolve("examples/freight"));
  naive = await runSuite({ domain: freight, agent: freightScriptedAgent("naive"), user: scriptedUser(), taskIds: tasks, k: 2 });
  careful = await runSuite({ domain: freight, agent: freightScriptedAgent("careful"), user: scriptedUser(), taskIds: tasks });
});

describe("critical tasks", () => {
  it("are optional booleans in the spec", () => {
    const task = freight.tasks.find((t) => t.id === "expired-insurance")!;
    expect(task.critical).toBe(true);
    expect(freight.tasks.find((t) => t.id === "book-at-posted-rate")!.critical).toBeUndefined();
    const raw = { ...freight, tasks: [{ ...task, critical: "yes" }] };
    expect(DomainSpec.safeParse(raw).success).toBe(false);
  });

  it("carry `critical: true` in results.json, and nothing on the other tasks", () => {
    const summary = (id: string) => naive.tasks.find((t) => t.id === id)!;
    expect(summary("expired-insurance").critical).toBe(true);
    expect(Object.hasOwn(summary("book-at-posted-rate"), "critical")).toBe(false);
    // results.json keeps spec order; only the reports put critical tasks first.
    expect(naive.tasks.map((t) => t.id)).toEqual(freight.tasks.map((t) => t.id).filter((id) => tasks.includes(id)));
  });

  it("fail only when a trial of one of them fails", () => {
    expect(criticalFailures(naive).map((t) => t.id)).toEqual(["expired-insurance", "inactive-authority"]);
    expect(criticalFailures(careful)).toEqual([]);
  });

  it("follow the domain a run is regraded under", () => {
    const edited: Domain = { ...freight, tasks: freight.tasks.map((t) => (t.id === "book-at-posted-rate" ? { ...t, critical: true } : t.id === "expired-insurance" ? { ...t, critical: false } : t)) };
    const r = regradeSuite(edited, naive);
    expect(criticalFailures(r).map((t) => t.id)).toEqual(["book-at-posted-rate", "inactive-authority"]);
    expect(Object.hasOwn(r.tasks.find((t) => t.id === "expired-insurance")!, "critical")).toBe(false);
  });
});

describe("the terminal summary", () => {
  it("lists critical tasks first, marked, and says how many passed every trial", () => {
    const lines = plain(renderTerminal(naive)).split("\n");
    const header = lines.findIndex((l) => l.trimStart().startsWith("task "));
    const rows = lines.slice(header + 1, lines.indexOf("", header));
    expect(rows.map((l) => l.trim().split(/\s+/)[0])).toEqual(["expired-insurance", "inactive-authority", "book-at-posted-rate", "walk-away-above-ceiling"]);
    expect(rows[0]).toMatch(/^ {2}expired-insurance +✗✗ +0\/2 {2}critical$/);
    expect(rows[2]).not.toContain("critical");
    expect(lines).toContain("  critical 0 of 2 passed every trial");
    for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(80);
    expect(plain(renderTerminal(careful))).toContain("  critical 2 of 2 passed every trial");
  });

  it("is unchanged for a run without critical tasks", () => {
    const r: SuiteResult = { ...careful, tasks: careful.tasks.filter((t) => !t.critical) };
    const text = plain(renderTerminal(r));
    expect(text).not.toContain("critical");
    expect(text).toMatch(/^ {2}book-at-posted-rate +✓ +1\/1$/m);
  });
});

/** Run the report's script against a stand-in page and return each element's HTML by id. */
function page(html: string): Map<string, { innerHTML: string }> {
  const script = html.slice(html.indexOf("<script>") + "<script>".length, html.indexOf("</script>"));
  const elements = new Map<string, { innerHTML: string; textContent: string; scrollIntoView(): void }>();
  const document = {
    getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, { innerHTML: "", textContent: "", scrollIntoView() {} });
      return elements.get(id)!;
    },
  };
  vm.runInContext(script, vm.createContext({ document }));
  return elements;
}

describe("the HTML report", () => {
  it("lists critical tasks first with a chip, flags the failed ones and opens the first of them", () => {
    const el = page(renderHtml(naive));
    const rows = el.get("tasks")!.innerHTML.split("<tr>").slice(1);
    expect(rows.map((r) => /<b>([^<]+)<\/b>/.exec(r)![1])).toEqual(["expired-insurance", "inactive-authority", "book-at-posted-rate", "walk-away-above-ceiling"]);
    expect(rows[0]).toContain('<span class="chip crit badc"');
    expect(rows[2]).not.toContain("crit");
    expect(el.get("kpis")!.innerHTML).toContain('<b class="badt">0 of 2</b><span>critical tasks passed every trial</span>');
    // book-at-posted-rate comes first in spec order, but the failed critical task is opened instead.
    expect(el.get("detail")!.innerHTML).toContain("expired-insurance · trial 1");
    // The dots still open the task they belong to in results.json.
    expect(rows[0]).toContain(`onclick="show(${naive.tasks.findIndex((t) => t.id === "expired-insurance")},0)"`);
  });

  it("shows a passed critical task's chip unflagged, and no critical KPI without critical tasks", () => {
    const el = page(renderHtml(careful));
    expect(el.get("tasks")!.innerHTML).toContain('<span class="chip crit" title="critical: passed every trial">critical</span>');
    expect(el.get("kpis")!.innerHTML).toContain("<b class=\"\">2 of 2</b>");
    const none = page(renderHtml({ ...careful, tasks: careful.tasks.filter((t) => !t.critical) }));
    expect(none.get("kpis")!.innerHTML).not.toContain("critical");
    expect(none.get("tasks")!.innerHTML).not.toContain("crit");
  });
});

describe.skipIf(!process.features.typescript)("`sandtable run`", () => {
  const cli = path.resolve("src/cli.ts");
  const run = (...args: string[]) => {
    const out = path.join(mkdtempSync(path.join(tmpdir(), "sandtable-critical-")), "out");
    return promisify(execFile)(process.execPath, [cli, "run", "examples/freight", "--user", "scripted", "--no-html", "-o", out, ...args]).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (e: { code: number; stdout: string; stderr: string }) => e,
    );
  };

  it("exits 1 and names the critical tasks that failed a trial, even without --fail-under", async () => {
    const r = await run("--agent", "scripted:naive", "-t", "expired-insurance,book-at-posted-rate,inactive-authority");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("✗ 2 critical task(s) did not pass every trial: expired-insurance 0/1, inactive-authority 0/1");
    expect(r.stderr).not.toContain("--fail-under");
  });

  it("prints both gates when both fail", async () => {
    const r = await run("--agent", "scripted:naive", "-t", "expired-insurance,book-at-posted-rate", "--fail-under", "100");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("✗ 1 critical task(s) did not pass every trial: expired-insurance 0/1");
    expect(r.stderr).toContain("is below --fail-under 100.0%");
  });

  it("exits 0 when every critical task passed every trial, whatever the other tasks did", async () => {
    const r = await run("--agent", "noop", "-t", "expired-insurance,book-at-posted-rate");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("critical 1 of 1 passed every trial");
    expect(r.stderr).not.toContain("critical");
  });
});
