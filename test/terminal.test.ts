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

    // 44 tasks broke verify-before-book: the first ones by name, then a count of the rest.
    const head = modes[0]!;
    expect(head).toMatch(/^ {2}44× invariant verify-before-book \(book-at-posted-rate, .*… \+\d+ more\)$/);
    const shown = head.slice(head.indexOf("(") + 1, head.indexOf("…")).split(", ").filter(Boolean).length;
    expect(shown + Number(head.match(/\+(\d+) more/)![1])).toBe(44);

    // A long example is cut at the edge with an ellipsis.
    expect(modes[1]).toMatch(/^ {5}e\.g\. book_load\(load_id="L-1001", mc_number="100101", rate=2100\) was called.*…$/);
    expect(modes[1]).toHaveLength(80);
  });
});

describe("terminal usage lines", () => {
  it("say how many model calls stopped at max_tokens, and nothing while none did", async () => {
    const r = await runSuite({ domain: await loadDomain(path.resolve("examples/freight")), agent: freightScriptedAgent("careful"), user: scriptedUser(), taskIds: ["no-mc-number"] });
    r.usage.agent = { "claude-haiku-5-5": { calls: 3, input: 900, output: 17000, cacheRead: 0, cacheWrite: 0 } };
    expect(plain(renderTerminal(r))).not.toContain("max_tokens");
    r.usage.agent["claude-haiku-5-5"]!.maxTokensStops = 1;
    expect(plain(renderTerminal(r))).toContain("agent claude-haiku-5-5: 3 calls, 900 in, 17.0k out, 0 cache read, 0 cache write, 1 stopped at max_tokens");
  });

  it("say how many replies had reasoning removed, and nothing while none did", async () => {
    const r = await runSuite({ domain: await loadDomain(path.resolve("examples/freight")), agent: freightScriptedAgent("careful"), user: scriptedUser(), taskIds: ["no-mc-number"] });
    r.usage.agent = { "openai.gpt-oss-120b-1:0": { calls: 3, input: 900, output: 1700, cacheRead: 0, cacheWrite: 0 } };
    expect(plain(renderTerminal(r))).not.toContain("reasoning removed");
    r.usage.agent["openai.gpt-oss-120b-1:0"]!.reasoningStripped = 2;
    expect(plain(renderTerminal(r))).toContain("agent openai.gpt-oss-120b-1:0: 3 calls, 900 in, 1.7k out, 0 cache read, 0 cache write, 2 with reasoning removed");
    expect(plain(renderTerminal(r))).not.toContain("silent");
    r.usage.agent["openai.gpt-oss-120b-1:0"]!.emptyAfterStrip = 1;
    expect(plain(renderTerminal(r))).toContain("2 with reasoning removed, 1 silent once it was removed");
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

describe("the judged score", () => {
  const counts = { pass: 3, fail: 1, notApplicable: 2 };
  async function judged() {
    const r = await runSuite({ domain: await loadDomain(path.resolve("examples/freight")), agent: freightScriptedAgent("careful"), user: scriptedUser(), taskIds: ["no-mc-number"] });
    r.judged = {
      ...counts,
      score: 0.75,
      models: ["claude-sonnet-5-5"],
      notJudged: 1,
      criteria: [
        { id: "reads-back", ...counts, score: 0.75 },
        { id: "polite", pass: 0, fail: 0, notApplicable: 0, score: null },
      ],
      usage: { "claude-sonnet-5-5": { calls: 4, input: 4000, output: 400, cacheRead: 0, cacheWrite: 0 } },
      costUsd: 0.012,
    };
    return r;
  }

  it("is shown apart from pass^k, labelled as a model's judgement, with its tokens and estimated cost", async () => {
    const text = plain(renderTerminal(await judged()));
    expect(text).toContain("Judged score (a model's judgement: it never changes pass/fail, pass^k, a gate or an exit code)");
    expect(text).toContain("judged 75.0%  3 pass, 1 fail, 2 not applicable, 1 not judged, by claude-sonnet-5-5");
    expect(text).toMatch(/reads-back +75\.0% {2}3 pass, 1 fail, 2 not applicable/);
    expect(text).toMatch(/polite +n\/a {2}no verdict yet/);
    expect(text).toContain("estimated cost $0.01");
    expect(text).toContain("judge claude-sonnet-5-5: 4 calls, 4.0k in, 400 out, 0 cache read, 0 cache write");
    // Above and unchanged: the deterministic score.
    expect(text.indexOf("pass^1 100.0%")).toBeLessThan(text.indexOf("Judged score"));
  });

  it("is absent from a run that was never judged", async () => {
    const r = await judged();
    delete r.judged;
    expect(plain(renderTerminal(r))).not.toMatch(/judged/i);
  });

  it("says in one line when the score rests on a pending criterion, without calling results provisional", async () => {
    const r = await judged();
    expect(plain(renderTerminal(r))).not.toContain("pending");
    r.judged!.criteria[0]!.pending = true;
    r.judged!.criteria[1]!.pending = true;
    const text = plain(renderTerminal(r));
    const lines = text.split("\n").filter((l) => l.includes("pending review"));
    // polite has no pass or fail, so the score doesn't rest on it.
    expect(lines).toEqual(["  ⚠ this score rests on 1 criterion still pending review: reads-back (npx sandtable-ai review <domain>)"]);
    expect(text).not.toContain("provisional");
  });

  it("counts the trials whose judge call failed", async () => {
    const r = await judged();
    r.tasks[0]!.trials[0]!.judged = { model: "claude-sonnet-5-5", verdicts: [], error: "overloaded" };
    expect(plain(renderTerminal(r))).toContain("1 trial's judge call failed: run npx sandtable-ai judge again to send it again");
  });
});
