import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
import { freightScriptedAgent } from "../src/demo/freight-agents.ts";
import { renderHtml } from "../src/report/html.ts";
import { renderTerminal } from "../src/report/terminal.ts";
import { regradeSuite } from "../src/run/regrade.ts";
import { runSuite, tagsBelowFloor, type SuiteResult } from "../src/run/suite.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import { loadDomain } from "../src/spec/load.ts";
import type { Domain } from "../src/spec/schema.ts";

// `run --floor <tag>=<pct>` gates one tag's pass^k, as --fail-under gates the whole suite's: a strong happy path
// can't carry weak refusals over the gate. With the naive freight agent on these tasks, `refusal` and `vetting`
// (no-mc-number) and `handoff` pass, and `happy-path` (book-at-posted-rate) fails. None of them is critical.

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tasks = ["payment-question-handoff", "no-mc-number", "book-at-posted-rate"];
let freight: Domain;
let naive: SuiteResult;

beforeAll(async () => {
  freight = await loadDomain(path.resolve("examples/freight"));
  naive = await runSuite({ domain: freight, agent: freightScriptedAgent("naive"), user: scriptedUser(), taskIds: tasks });
});

describe("tagsBelowFloor", () => {
  it("lists each tag whose pass^k is below its floor, in the order the floors were given", () => {
    expect(tagsBelowFloor({ ...naive, floors: { refusal: 1, "happy-path": 1 } }).map((t) => [t.tag, t.floor])).toEqual([["happy-path", 1]]);
    expect(tagsBelowFloor({ ...naive, floors: { refusal: 1, handoff: 1 } })).toEqual([]);
    expect(tagsBelowFloor({ ...naive, floors: { "happy-path": 0 } })).toEqual([]);
    expect(tagsBelowFloor(naive)).toEqual([]);
  });

  it("fails a tag with no graded trial, as --fail-under fails a run with none", () => {
    const r: SuiteResult = { ...naive, byTag: naive.byTag.map((t) => (t.tag === "refusal" ? { ...t, passHatK: Number.NaN } : t)), floors: { refusal: 0.5 } };
    expect(tagsBelowFloor(r).map((t) => t.tag)).toEqual(["refusal"]);
  });

  it("keeps the floors through regrade, which re-scores the tags", () => {
    const r = regradeSuite(freight, { ...naive, floors: { "happy-path": 1 } });
    expect(r.floors).toEqual({ "happy-path": 1 });
    expect(tagsBelowFloor(r).map((t) => t.tag)).toEqual(["happy-path"]);
  });
});

describe("the terminal summary", () => {
  it("marks a tag below its floor and shows every floor next to its tag", () => {
    const lines = plain(renderTerminal({ ...naive, floors: { refusal: 1, "happy-path": 1 } })).split("\n");
    expect(lines.find((l) => l.trimStart().startsWith("happy-path"))).toMatch(/pass\^1 +0\.0% +✗ below floor 100\.0%$/);
    expect(lines.find((l) => l.trimStart().startsWith("refusal"))).toMatch(/pass\^1 +100\.0% +floor 100\.0%$/);
    expect(lines.find((l) => l.trimStart().startsWith("handoff"))).not.toContain("floor");
    for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(80);
  });

  it("shows the tag table for a floor even when the run has a single tag", () => {
    const one = { ...naive, byTag: naive.byTag.filter((t) => t.tag === "refusal") };
    expect(plain(renderTerminal(one))).not.toContain("By tag");
    expect(plain(renderTerminal({ ...one, floors: { refusal: 1 } }))).toContain("By tag");
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
  it("adds a floor column and flags a tag below its floor", () => {
    const tags = page(renderHtml({ ...naive, floors: { refusal: 1, "happy-path": 1 } })).get("tags")!.innerHTML;
    expect(tags).toContain("<th>Floor</th>");
    const row = (tag: string) => tags.split("<tr>").find((r) => r.includes(`>${tag}</span>`))!;
    expect(row("happy-path")).toContain("<td class='badt'>100.0% ✗</td>");
    expect(row("refusal")).toContain("<td>100.0%</td>");
    expect(row("handoff")).toContain("<td class='meta'>none</td>");
    expect(page(renderHtml(naive)).get("tags")!.innerHTML).not.toContain("Floor");
  });
});

describe.skipIf(!process.features.typescript)("`sandtable run --floor`", () => {
  const cli = path.resolve("src/cli.ts");
  const run = (...args: string[]) => {
    const out = path.join(mkdtempSync(path.join(tmpdir(), "sandtable-floor-")), "out");
    return promisify(execFile)(process.execPath, [cli, "run", "examples/freight", "--agent", "scripted:naive", "--user", "scripted", "--no-html", "-o", out, "-t", tasks.join(","), ...args]).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr, out }),
      (e: { code: number; stdout: string; stderr: string }) => ({ ...e, out }),
    );
  };

  it("exits 0 when every tag with a floor meets it, and records the floors in results.json", async () => {
    const r = await run("--floor", "refusal=100", "--floor", "handoff=90%");
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("floor");
    expect(JSON.parse(readFileSync(path.join(r.out, "results.json"), "utf8")).floors).toEqual({ refusal: 1, handoff: 0.9 });
  });

  it("exits 1 and names each tag below its floor, with or without --fail-under", async () => {
    const r = await run("--floor", "refusal=100", "--floor", "happy-path=50");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("✗ 1 tag(s) below their --floor: happy-path pass^1 0.0% < 50.0%");
    const both = await run("--floor", "happy-path=50", "--fail-under", "90");
    expect(both.code).toBe(1);
    expect(both.stderr).toContain("is below --fail-under 90.0%");
    expect(both.stderr).toContain("happy-path pass^1 0.0% < 50.0%");
  });

  it("refuses a tag no task in the run carries before any trial runs, so a typo can't pass", async () => {
    const r = await run("--floor", "refusl=100");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^--floor: no task in this run is tagged "refusl" \(its tags: handoff, happy-path, refusal, vetting\)/);
    expect(r.stdout).toBe("");
    // A tag the domain has, but none of the tasks this run selected.
    expect((await run("--floor", "negotiation=80")).stderr).toContain('no task in this run is tagged "negotiation"');
  });

  it("refuses a malformed floor, a percentage outside 0-100 and the same tag twice as usage errors", async () => {
    for (const [args, message] of [
      [["--floor", "refusal"], "must be <tag>=<pct>"],
      [["--floor", "=100"], "must be <tag>=<pct>"],
      [["--floor", "refusal=lots"], "the percentage must be 0-100"],
      [["--floor", "refusal=150"], "the percentage must be 0-100"],
      [["--floor", "refusal=100", "--floor", "refusal=90"], "refusal has a floor already"],
    ] as const) {
      const r = await run(...args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.stderr, args.join(" ")).toContain(message);
    }
  });
});
