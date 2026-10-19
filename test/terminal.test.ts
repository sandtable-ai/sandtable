import path from "node:path";
import { describe, expect, it } from "vitest";
import { freightScriptedAgent } from "../src/demo/freight-agents.ts";
import { fitList, renderTerminal } from "../src/report/terminal.ts";
import { runSuite } from "../src/run/suite.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import { loadDomain } from "../src/spec/load.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("terminal summary", () => {
  it("keeps every failure-mode line inside 80 columns", async () => {
    const r = await runSuite({ domain: await loadDomain(path.resolve("examples/freight")), agent: freightScriptedAgent("naive"), user: scriptedUser() });
    const lines = plain(renderTerminal(r)).split("\n");
    const modes = lines.slice(lines.indexOf("  Top failure modes") + 1);
    expect(modes).toHaveLength(16);
    for (const line of modes) expect(line.length, line).toBeLessThanOrEqual(80);

    // 25 tasks broke verify-before-book: the first ones by name, then a count of the rest.
    const head = modes[0]!;
    expect(head).toMatch(/^ {2}25× invariant verify-before-book \(book-at-posted-rate, .*… \+\d+ more\)$/);
    const shown = head.slice(head.indexOf("(") + 1, head.indexOf("…")).split(", ").filter(Boolean).length;
    expect(shown + Number(head.match(/\+(\d+) more/)![1])).toBe(25);

    // A long example is cut at the edge with an ellipsis.
    expect(modes[1]).toMatch(/^ {5}e\.g\. book_load\(load_id="L-1001", mc_number="100101", rate=2100\) was called.*…$/);
    expect(modes[1]).toHaveLength(80);
  });
});

describe("fitList", () => {
  it("shows a list whole when it fits", () => {
    expect(fitList(["walk-away", "expired-insurance"], 40)).toBe("(walk-away, expired-insurance)");
  });

  it("names as many as fit, then counts the rest", () => {
    const ids = ["book-at-posted-rate", "negotiate-within-ceiling", "walk-away-above-ceiling", "expired-insurance"];
    expect(fitList(ids, 60)).toBe("(book-at-posted-rate, negotiate-within-ceiling, … +2 more)");
    expect(fitList(ids, 32)).toBe("(book-at-posted-rate, … +3 more)");
    expect(fitList(ids, 31)).toBe("(4 tasks)");
  });

  it("falls back to a count when not even one name fits", () => {
    expect(fitList(["book-at-posted-rate", "expired-insurance"], 12)).toBe("(2 tasks)");
  });
});
