import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { freightScriptedAgent } from "../src/demo/freight-agents.ts";
import { checkCall, type CallRecord } from "../src/grade/invariants.ts";
import { lintDomain } from "../src/grade/lint.ts";
import { renderHtml } from "../src/report/html.ts";
import { renderTerminal } from "../src/report/terminal.ts";
import { renderLeaderboardMarkdown, runLeaderboard } from "../src/run/leaderboard.ts";
import { runSuite } from "../src/run/suite.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import type { AgentAdapter } from "../src/sim/types.ts";
import { loadDomain, validateDomain } from "../src/spec/load.ts";
import { DomainSpec, type Domain, type Task } from "../src/spec/schema.ts";
import { World } from "../src/world/store.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

let domain: Domain;
beforeAll(async () => {
  domain = await loadDomain(path.resolve("examples/freight"));
});

/** Counters at the ceiling on the caller's first ask, then takes the caller's next price. */
const concedes: AgentAdapter = {
  name: "concedes",
  async createSession() {
    let turn = 0;
    return {
      async reply(_text, callTool) {
        turn++;
        if (turn === 1) {
          await callTool("verify_carrier", { mc_number: "100101" });
          await callTool("get_load", { load_id: "L-1001" });
          return "You're all set to haul for us. L-1001 pays $2,100 all-in.";
        }
        if (turn === 2) {
          await callTool("log_offer", { load_id: "L-1001", mc_number: "100101", round: 1, carrier_ask: 2600, counter_offer: 2350 });
          return "I can do $2,350 all-in.";
        }
        if (turn === 3) {
          await callTool("book_load", { load_id: "L-1001", mc_number: "100101", rate: 2300 });
          return "Booked L-1001 at $2,300.";
        }
        return "Thanks for calling.";
      },
    };
  },
};

describe("limit: strict bounds", () => {
  const verified: CallRecord = { index: 0, name: "verify_carrier", args: { mc_number: "100101" }, ok: true };
  const counter = (counter_offer: number) =>
    checkCall(domain, new World(domain.world), [verified], {
      index: 1,
      name: "log_offer",
      args: { load_id: "L-1001", mc_number: "100101", round: 1, carrier_ask: 2600, counter_offer },
    });

  it("lt is broken at the bound, lte only above it", () => {
    expect(counter(2300)).toEqual([]);
    expect(counter(2350)).toEqual([
      expect.objectContaining({ invariant: "counter-at-ceiling", soft: true, detail: "log_offer counter_offer=2350 is not below 2350" }),
    ]);
    expect(counter(2400).map((v) => [v.invariant, v.soft])).toEqual([
      ["offer-ceiling", undefined],
      ["counter-at-ceiling", true],
    ]);
  });

  it("gt is broken at the bound", () => {
    const floor = { ...domain, invariants: [{ id: "above-posted", description: "x", limit: { tool: "log_offer", arg: "counter_offer", gt: { table: "loads", key_arg: "load_id", field: "posted_rate" } } }] };
    const at = (counter_offer: number) =>
      checkCall(DomainSpec.parse(floor), new World(domain.world), [], { index: 0, name: "log_offer", args: { load_id: "L-1001", counter_offer } }).map((v) => v.detail);
    expect(at(2150)).toEqual([]);
    expect(at(2100)).toEqual(["log_offer counter_offer=2100 is not above 2100"]);
  });

  it("validate checks the tables and args a strict bound points at", () => {
    const broken = DomainSpec.parse({
      ...domain,
      invariants: [{ id: "x", description: "x", soft: true, limit: { tool: "log_offer", arg: "counter_offer", lt: { table: "lanes", key_arg: "lane_id", field: "max" } } }],
    });
    expect(validateDomain(broken)).toEqual(['invariants.x: unknown table "lanes"', 'invariants.x: tool "log_offer" has no param "lane_id"']);
  });

  it("every invariant kind accepts soft", () => {
    const kinds = [
      { before: { first: "verify_carrier", then: "book_load" } },
      { require: { tool: "book_load", table: "loads", key_arg: "load_id", where: { status: "available" } } },
      { limit: { tool: "book_load", arg: "rate", lt: 3000 } },
      { match: { tool: "book_load", left: { table: "loads", key_arg: "load_id", field: "equipment" }, right: { table: "carriers", key_arg: "mc_number", field: "equipment" } } },
      { never: { tool: "transfer_to_human" } },
      { never_disclose: { table: "loads", field: "posted_rate" } },
    ];
    for (const kind of kinds) expect(DomainSpec.safeParse({ ...domain, invariants: [{ id: "x", description: "x", soft: true, ...kind }] }).success).toBe(true);
  });
});

describe("soft invariants in a run", () => {
  it("are reported per trial and per run, and never fail a trial", async () => {
    const r = await runSuite({ domain, agent: concedes, user: scriptedUser(), taskIds: ["negotiate-within-ceiling"] });
    const trial = r.tasks[0]!.trials[0]!;
    expect(trial.passed).toBe(true);
    expect(trial.violations).toEqual([]);
    expect(trial.checks.some((c) => c.id === "counter-at-ceiling")).toBe(false);
    expect(trial.soft).toEqual([{ id: "counter-at-ceiling", broken: true, violations: [expect.objectContaining({ callIndex: 2, soft: true })] }]);
    const offer = trial.events.find((e) => e.type === "tool" && e.name === "log_offer");
    expect(offer).toMatchObject({ violations: [], soft: ["counter-at-ceiling"] });
    expect(r.passHat["1"]).toBe(1);
    expect(r.failureModes).toEqual([]);
    expect(r.soft).toEqual([
      {
        id: "counter-at-ceiling",
        description: expect.any(String),
        tool: "log_offer",
        applied: 1,
        broken: 1,
        rate: 1,
        tasks: ["negotiate-within-ceiling"],
        example: "log_offer counter_offer=2350 is not below 2350",
      },
    ]);
  });

  it("count only the trials where the rule applied", async () => {
    const r = await runSuite({
      domain,
      agent: freightScriptedAgent("careful"),
      user: scriptedUser(),
      taskIds: ["negotiate-two-rounds", "book-at-posted-rate", "expired-insurance"],
    });
    // Only negotiate-two-rounds calls log_offer; the careful agent counters below the ceiling.
    expect(r.soft[0]).toMatchObject({ applied: 1, broken: 0, rate: 0, tasks: [] });
    expect(r.tasks.find((t) => t.id === "book-at-posted-rate")!.trials[0]!.soft).toEqual([]);
    const text = plain(renderTerminal(r));
    expect(text).toContain("Soft rules (reported, never fail a trial)");
    expect(text).toMatch(/counter-at-ceiling +0\.0% {2}0 of 1 trials that called log_offer/);
    expect(renderHtml(r)).toContain("<h2>Soft rules</h2>");
  });

  it("have no rate when they never applied", async () => {
    const r = await runSuite({ domain, agent: freightScriptedAgent("careful"), user: scriptedUser(), taskIds: ["book-at-posted-rate"] });
    expect(r.soft[0]).toMatchObject({ applied: 0, broken: 0, rate: null });
    expect(plain(renderTerminal(r))).toContain("counter-at-ceiling  no rate: no trial called log_offer");
  });

  it("apply never_disclose to every trial in which the agent spoke", async () => {
    const said = DomainSpec.parse({
      ...domain,
      invariants: [...domain.invariants, { id: "says-posted-rate", description: "x", soft: true, never_disclose: { table: "loads", field: "posted_rate" } }],
    });
    const r = await runSuite({ domain: said, agent: concedes, user: scriptedUser(), taskIds: ["negotiate-within-ceiling"] });
    expect(r.tasks[0]!.trials[0]!.passed).toBe(true);
    expect(r.soft.find((x) => x.id === "says-posted-rate")).toMatchObject({ applied: 1, broken: 1, example: "agent message 1 disclosed loads.posted_rate=2100" });
    expect(r.soft.find((x) => x.id === "says-posted-rate")!.tool).toBeUndefined();
  });

  it("never make a lint reference unsolvable", () => {
    const task: Task = {
      id: "concede",
      tags: [],
      user: { instructions: "x" },
      reference: [
        { tool: "verify_carrier", args: { mc_number: "100101" } },
        { tool: "log_offer", args: { load_id: "L-1001", mc_number: "100101", round: 1, carrier_ask: 2600, counter_offer: 2350 } },
        { tool: "book_load", args: { load_id: "L-1001", mc_number: "100101", rate: 2350 } },
      ],
      expect: { state: [{ table: "bookings", where: { load_id: "L-1001" }, count: 1 }], called: [], not_called: [], reply_includes: [] },
    };
    const report = lintDomain(DomainSpec.parse({ ...domain, tasks: [task] }));
    expect(report.tasks[0]).toMatchObject({ solvable: true, errors: [] });
  });
});

describe("soft invariants on the leaderboard", () => {
  it("show each model's rate, and n/a where the rule never applied", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-soft-"));
    const lb = await runLeaderboard({
      domain,
      entries: [
        { label: "Concedes", agent: "concedes" },
        { label: "Careful rules", agent: "scripted:careful" },
      ],
      user: scriptedUser(),
      k: 1,
      taskIds: ["negotiate-within-ceiling", "expired-insurance"],
      outDir: dir,
      resolveAgent: async (spec) => (spec === "concedes" ? concedes : freightScriptedAgent("careful")),
    });
    const row = (label: string) => lb.rows.find((r) => r.label === label)!;
    // The conceding agent counters at the ceiling in both tasks, whatever the caller says.
    expect(row("Concedes").soft).toEqual({ "counter-at-ceiling": { applied: 2, broken: 2, rate: 1 } });
    expect(row("Careful rules").soft).toEqual({ "counter-at-ceiling": { applied: 1, broken: 0, rate: 0 } });
    expect(row("Do-nothing baseline").soft).toEqual({ "counter-at-ceiling": { applied: 0, broken: 0, rate: null } });
    const md = renderLeaderboardMarkdown(lb);
    expect(md).toContain("| Top failure | Soft rules | Cost / trial |");
    expect(md).toContain("| counter-at-ceiling 100.0% (2/2) |");
    expect(md).toContain("| counter-at-ceiling 0.0% (0/1) |");
    expect(md).toContain("| counter-at-ceiling n/a |");
    expect(await readFile(path.join(dir, "leaderboard.html"), "utf8")).toContain("<th>Soft rules</th>");
  });

  it("leave the table as it was for a domain without soft rules", async () => {
    const hard = DomainSpec.parse({ ...domain, invariants: domain.invariants.filter((i) => !i.soft) });
    const lb = await runLeaderboard({
      domain: hard,
      entries: [{ label: "Careful rules", agent: "scripted:careful" }],
      user: scriptedUser(),
      k: 1,
      taskIds: ["book-at-posted-rate"],
      outDir: await mkdtemp(path.join(os.tmpdir(), "sandtable-soft-")),
      resolveAgent: async () => freightScriptedAgent("careful"),
    });
    expect(renderLeaderboardMarkdown(lb)).not.toContain("Soft rules");
  });
});
