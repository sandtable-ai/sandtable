import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { freightScriptedAgent } from "../src/demo/freight-agents.ts";
import { renderCustomerHtml } from "../src/report/customer.ts";
import { runSuite, type SuiteResult } from "../src/run/suite.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import { loadDomain } from "../src/spec/load.ts";
import { DomainSpec, type Domain } from "../src/spec/schema.ts";

let freight: Domain;
let careful: SuiteResult;
let naive: SuiteResult;

beforeAll(async () => {
  freight = await loadDomain(path.resolve("examples/freight"));
  careful = await runSuite({ domain: freight, agent: freightScriptedAgent("careful"), user: scriptedUser() });
  naive = await runSuite({ domain: freight, agent: freightScriptedAgent("naive"), user: scriptedUser() });
});

/** The rule card of one rule, by its id in the card's footer. */
function card(html: string, id: string): string {
  const cards = html.split('<div class="rule');
  return cards.find((c) => c.includes(`<div class="meta">${id} · `)) ?? "";
}

describe("the customer sign-off page", () => {
  it("shows a clean run with the careless agent's evidence: quoted sources, caught rules and no open items", () => {
    const html = renderCustomerHtml(careful, { probe: naive });
    expect(html).not.toContain("<script");
    expect(html).toContain("No open items");
    expect(html).toContain("A deliberately careless agent was rehearsed too. The rehearsal caught it breaking 10 of the 18 rules that fail a conversation.");
    const ceiling = card(html, "rate-ceiling");
    // The quote keeps its Markdown bold and code, as the customer's document has them.
    expect(ceiling).toContain("“<b>Never book above <code>max_rate</code>.</b>”<cite>policy.md</cite>");
    expect(ceiling).toMatch(/<span class="chip">held<\/span> Held in all \d+ conversations where it applied/);
    expect(ceiling).toMatch(/<span class="chip">caught<\/span> A deliberately careless agent broke it in \d+ scenarios?, and the rehearsal failed those conversations/);
    // The evidence that it was caught is open, so it prints in any browser.
    expect(ceiling).toContain("<details open><summary>How the careless agent was caught");
    // The quote for a rule whose conditions are a list keeps the list.
    expect(card(html, "eligible-carrier")).toContain("insurance is not <code>valid</code>");
    // The scenarios table names each scenario and its id, without the engineers' tags.
    expect(html).not.toContain("expired-insurance · vetting");
    // Checked is not caught: the careless agent never leaked the ceiling, so the page doesn't claim the scenarios catch it.
    expect(card(html, "never-disclose-ceiling")).toContain('<span class="chip line">not shown caught</span>');
    // A rule without a source shows no quote.
    expect(card(html, "book-existing-load")).not.toContain("<blockquote>");
    expect(html).toContain("Reviewed and accepted by");
  });

  it("lists the open items of a failing run, and doesn't claim what was caught without a probe", () => {
    const html = renderCustomerHtml(naive);
    expect(html).toMatch(/<b class="big badt">\d+ open items before go-live<\/b>/);
    expect(html).toContain("Critical scenario “Carrier with expired insurance asks to book; the agent must decline” failed in 1 of 1 conversation.");
    expect(html).toMatch(/The rule “A carrier must be looked up with verify_carrier before it is booked\.” was broken in \d+ conversations\./);
    expect(html).toMatch(/\d+ scenarios didn't pass every conversation: “[^”]+”, “[^”]+”, “[^”]+”, and \d+ more in Scenarios\./);
    expect(html).not.toContain('<span class="chip">caught</span>');
    expect(html).toContain("rehearse a careless agent too to show it");
    // A conversation in which the agent broke a rule is open, so it prints.
    expect(card(html, "verify-before-book")).toMatch(/<details open><summary>Example conversation: [^<]*\(broke the rule\)/);
    // Rules nothing checked are listed as not covered, with their cards marked.
    expect(html).toMatch(/<b>5 rules no conversation checked\.<\/b>/);
    expect(card(html, "offer-ceiling")).toContain('<span class="chip line">not checked</span>');
    expect(html).toContain("<code>log_offer</code>");
  });

  it("never calls a broken soft rule caught: it is reported, and it is no open item", async () => {
    // counter-at-ceiling with a bound every counter-offer breaks: soft, so the trials that break it still pass.
    const strict = DomainSpec.parse({
      ...freight,
      invariants: freight.invariants.map((inv) => (inv.id === "counter-at-ceiling" && "limit" in inv ? { ...inv, limit: { tool: inv.limit.tool, arg: inv.limit.arg, lt: 100 } } : inv)),
    });
    const probe = await runSuite({ domain: strict, agent: freightScriptedAgent("careful"), user: scriptedUser() });
    const html = renderCustomerHtml(probe, { probe });
    const soft = card(html, "counter-at-ceiling");
    expect(soft).toContain('<span class="chip">reported</span> Broken in');
    expect(soft).toContain("As a soft rule, it never fails a conversation, so it can't be caught.");
    expect(soft).not.toContain('<span class="chip">caught</span>');
    expect(soft).not.toContain("chip bad");
    expect(soft).toContain("How the careless agent broke it (reported, not caught)");
    expect(html).toContain("None of the 18 rules that fail a conversation was broken, and 1 soft rule was broken (reported, never a failure).");
    expect(html).toContain("No open items");
    expect(html).toContain("The rehearsal caught it breaking 0 of the 18 rules that fail a conversation.");
  });

  it("names drafted items pending review and ungraded conversations as open items", () => {
    const pending: SuiteResult = {
      ...careful,
      pendingReview: [{ kind: "invariant", id: "rate-ceiling" }],
      tasks: careful.tasks.map((t, i) => (i === 0 ? { ...t, skipped: 1, graded: 0, passes: 0 } : t)),
    };
    const html = renderCustomerHtml(pending);
    expect(html).toContain("1 item drafted from your documents hasn't been reviewed by a person yet, so these results are provisional.");
    expect(html).toContain("1 conversation ended in an error before it could be graded, so the rehearsal is incomplete. Rerun it.");
  });

  it("escapes what the run holds", () => {
    const hostile: SuiteResult = { ...careful, tasks: careful.tasks.map((t, i) => (i === 0 ? { ...t, description: "<img src=x onerror=alert(1)>" } : t)) };
    const html = renderCustomerHtml(hostile);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("refuses a run without coverage, and a probe of another domain", () => {
    const { coverage: _, ...old } = careful;
    expect(() => renderCustomerHtml(old as SuiteResult)).toThrow(/no coverage/);
    expect(() => renderCustomerHtml(careful, { probe: { ...naive, domain: "clinic-front-desk" } })).toThrow(/is a run of clinic-front-desk/);
  });
});

describe("report --audience customer", () => {
  const cli = (...args: string[]) => spawnSync(process.execPath, ["src/cli.ts", "report", ...args], { encoding: "utf8" });
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "sandtable-customer-"));
    writeFileSync(path.join(dir, "results.json"), JSON.stringify(careful));
    writeFileSync(path.join(dir, "careless.json"), JSON.stringify(naive));
  });

  it("writes customer-report.html next to results.json, leaving report.html alone", () => {
    const res = cli(path.join(dir, "results.json"), "--audience", "customer", "--probe", path.join(dir, "careless.json"));
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(path.join(dir, "customer-report.html"));
    expect(readFileSync(path.join(dir, "customer-report.html"), "utf8")).toContain("Go-live rehearsal: freight-carrier-sales");
    expect(existsSync(path.join(dir, "report.html"))).toBe(false);
    const into = cli(path.join(dir, "results.json"), "--audience", "customer", "-o", path.join(dir, "out"));
    expect(into.stdout.trim()).toBe(path.join(dir, "out", "customer-report.html"));
  });

  it("refuses --probe without --audience customer, an unknown audience, and a run without coverage, with exit 2", () => {
    const probe = cli(path.join(dir, "results.json"), "--probe", path.join(dir, "careless.json"));
    expect(probe.status).toBe(2);
    expect(probe.stderr).toContain("--probe is for --audience customer");
    expect(cli(path.join(dir, "results.json"), "--audience", "board").status).toBe(2);
    const { coverage: _, ...old } = careful;
    writeFileSync(path.join(dir, "old.json"), JSON.stringify(old));
    const res = cli(path.join(dir, "old.json"), "--audience", "customer");
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/has no coverage: it was written before sandtable-ai 1\.1\. Add it with `npx sandtable-ai regrade .*old\.json -d <domain>`/);
  });
});
