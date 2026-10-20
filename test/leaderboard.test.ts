import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freightScriptedAgent } from "../src/demo/freight-agents.ts";
import { runLeaderboard } from "../src/run/leaderboard.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import type { AgentAdapter } from "../src/sim/types.ts";
import { loadDomain } from "../src/spec/load.ts";

const example = path.resolve("examples/freight");
const agents: Record<string, () => AgentAdapter> = {
  "scripted:careful": () => freightScriptedAgent("careful"),
  "scripted:naive": () => freightScriptedAgent("naive"),
};

describe("leaderboard", () => {
  it("ranks agents by pass^k, adds the do-nothing baseline, and writes json, markdown and html", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-lb-"));
    const domain = await loadDomain(example);
    const lb = await runLeaderboard({
      domain,
      entries: [
        { label: "Naive rules", agent: "scripted:naive" },
        { label: "Careful rules", agent: "scripted:careful" },
        { label: "Broken", agent: "nope" },
      ],
      user: scriptedUser(),
      k: 2,
      outDir: dir,
      resolveAgent: async (spec) => {
        const make = agents[spec];
        if (!make) throw new Error(`unknown agent ${spec}`);
        return make();
      },
    });

    expect(lb.rows.map((r) => r.label)).toEqual(["Careful rules", "Do-nothing baseline", "Naive rules", "Broken"]);
    const careful = lb.rows[0]!;
    expect(careful).toMatchObject({ passHat1: 1, passHatK: 1, trials: domain.tasks.length * 2, costUsd: null });
    const naive = lb.rows.find((r) => r.label === "Naive rules")!;
    expect(naive.violations["verify-before-book"]).toBeGreaterThan(0);
    expect(lb.rows.find((r) => r.baseline)!.passHatK).toBeCloseTo(16 / 50);
    expect(lb.rows.at(-1)!.error).toMatch(/unknown agent nope/);

    const md = await readFile(path.join(dir, "LEADERBOARD.md"), "utf8");
    expect(md).toContain("| 1 | Careful rules | 100.0% | 100.0% |");
    expect(md).toContain("_Do-nothing baseline_");
    expect(await readFile(path.join(dir, "leaderboard.html"), "utf8")).toContain('href="./careful-rules/report.html"');
    expect(await readFile(path.join(dir, "careful-rules", "results.json"), "utf8")).toContain('"agent": "scripted:careful"');
  });

  it("resumes from existing results instead of rerunning a model", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-lb-"));
    const domain = await loadDomain(example);
    const base = { domain, user: scriptedUser(), k: 1, outDir: dir, entries: [{ label: "Careful rules", agent: "scripted:careful" }] };
    await runLeaderboard({ ...base, resolveAgent: async () => freightScriptedAgent("careful") });
    const seen: string[] = [];
    const again = await runLeaderboard({
      ...base,
      resolveAgent: async () => {
        throw new Error("should not rerun");
      },
      onEntry: (label, status) => seen.push(`${label}:${status}`),
    });
    expect(seen).toEqual(["Careful rules:cached"]);
    expect(again.rows[0]!.passHat1).toBe(1);
  });

  it("reruns a model whose stored results are for another k, caller or task set, or have crashed trials", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-lb-"));
    const domain = await loadDomain(example);
    const entries = [{ label: "Careful rules", agent: "scripted:careful" }];
    const careful = async () => freightScriptedAgent("careful");
    const run = async (opts: { k: number; taskIds?: string[] }) => {
      const seen: string[] = [];
      const lb = await runLeaderboard({ domain, entries, user: scriptedUser(), outDir: dir, resolveAgent: careful, onEntry: (_l, status, note) => seen.push(`${status}${note ? `: ${note}` : ""}`), ...opts });
      return { lb, seen };
    };
    await run({ k: 1 });
    expect((await run({ k: 2 })).seen).toEqual(["ran: stored results not reused: they are for k=1, not k=2"]);
    const subset = await run({ k: 2, taskIds: ["book-at-posted-rate", "no-mc-number"] });
    expect(subset.seen).toEqual(["ran: stored results not reused: they cover different tasks"]);
    expect(subset.lb.rows.map((r) => r.tasks)).toEqual([2, 2]);
    expect((await run({ k: 2, taskIds: ["no-mc-number", "book-at-posted-rate"] })).seen).toEqual(["cached"]);

    const file = path.join(dir, "careful-rules", "results.json");
    const stored = JSON.parse(await readFile(file, "utf8"));
    stored.tasks[0].trials[0].endReason = "error";
    await writeFile(file, JSON.stringify(stored));
    expect((await run({ k: 2, taskIds: ["book-at-posted-rate", "no-mc-number"] })).seen).toEqual(["ran: stored results not reused: 1 trial(s) crashed"]);
  });

  it("reruns a model whose agent spec, or what the agent and the caller are given, changed under the same label", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-lb-"));
    const domain = await loadDomain(example);
    const taskIds = ["book-at-posted-rate", "no-mc-number"];
    const run = async (agent: string, d = domain) => {
      const seen: string[] = [];
      const lb = await runLeaderboard({
        domain: d,
        entries: [{ label: "Candidate", agent }],
        user: scriptedUser(),
        k: 1,
        taskIds,
        outDir: dir,
        resolveAgent: async (spec) => agents[spec]!(),
        onEntry: (_l, status, note) => seen.push(`${status}${note ? `: ${note}` : ""}`),
      });
      return { row: lb.rows.find((r) => r.label === "Candidate")!, seen };
    };
    expect((await run("scripted:careful")).row.passHat1).toBe(1);
    expect((await run("scripted:careful")).seen).toEqual(["cached"]);

    const swapped = await run("scripted:naive");
    expect(swapped.seen).toEqual(["ran: stored results not reused: they are for agent scripted:careful, not scripted:naive"]);
    expect(swapped.row.passHat1).toBeLessThan(1);
    expect(JSON.parse(await readFile(path.join(dir, "candidate", "run.json"), "utf8"))).toMatchObject({ agent: "scripted:naive" });

    const edited = { ...domain, policy: `${domain.policy}\n\nA new rule.` };
    expect((await run("scripted:naive", edited)).seen).toEqual([
      "ran: stored results not reused: the agent or the caller would be given something else now: the policy, a tool's schema, or a task's caller prompt, opening, script or turn limit changed since it ran",
    ]);
    expect((await run("scripted:naive", edited)).seen).toEqual(["cached"]);
  });

  it("grades stored results again under the current rules instead of reusing their verdicts, without calling a model", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-lb-"));
    const domain = await loadDomain(example);
    const taskIds = ["book-at-posted-rate", "no-mc-number"];
    const run = async (d: typeof domain, resolveAgent = async () => freightScriptedAgent("careful")) => {
      const seen: string[] = [];
      const lb = await runLeaderboard({ domain: d, entries: [{ label: "Careful rules", agent: "scripted:careful" }], user: scriptedUser(), k: 1, taskIds, outDir: dir, resolveAgent, onEntry: (_l, status, note) => seen.push(`${status}${note ? `: ${note}` : ""}`) });
      return { row: lb.rows.find((r) => r.label === "Careful rules")!, seen };
    };
    const noModel = async (): Promise<never> => {
      throw new Error("should not call the agent");
    };
    expect((await run(domain)).row.passHat1).toBe(1);

    // A grading rule added after the run applies to the stored conversations.
    const stricter = { ...domain, invariants: [...domain.invariants, { id: "no-l1001", description: "Never book L-1001.", never: { tool: "book_load", when: { load_id: "L-1001" } } }] };
    const regraded = await run(stricter, noModel);
    expect(regraded.seen).toEqual(["regraded: 1 verdict(s) changed under the current rules"]);
    expect(regraded.row).toMatchObject({ passHat1: 0.5, violations: { "no-l1001": 1 } });
    const onDisk = JSON.parse(await readFile(path.join(dir, "careful-rules", "results.json"), "utf8"));
    expect(onDisk.failureModes[0]).toMatchObject({ id: "no-l1001", tasks: ["book-at-posted-rate"] });
    expect(await readFile(path.join(dir, "careful-rules", "report.html"), "utf8")).toContain("no-l1001");

    expect((await run(stricter, noModel)).seen).toEqual(["cached"]);
    const restored = await run(domain, noModel);
    expect(restored.seen).toEqual(["regraded: 1 verdict(s) changed under the current rules"]);
    expect(restored.row.passHat1).toBe(1);
  });

  it("reruns stored results that record no inputs fingerprint, since they can't be graded again", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-lb-"));
    const domain = await loadDomain(example);
    const base = { domain, user: scriptedUser(), k: 1, taskIds: ["no-mc-number"], outDir: dir, entries: [{ label: "Careful rules", agent: "scripted:careful" }] };
    await runLeaderboard({ ...base, resolveAgent: async () => freightScriptedAgent("careful") });
    const file = path.join(dir, "careful-rules", "results.json");
    const { inputs: _, ...older } = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify(older));
    const seen: string[] = [];
    await runLeaderboard({ ...base, resolveAgent: async () => freightScriptedAgent("careful"), onEntry: (_l, status, note) => seen.push(`${status}: ${note}`) });
    expect(seen).toEqual([expect.stringMatching(/^ran: stored results not reused: it was written by an older sandtable and records no inputs fingerprint/)]);
    expect(JSON.parse(await readFile(file, "utf8")).inputs).toMatch(/^[0-9a-f]{16}$/);
  });

  it("reruns results stored without run.json, since nothing says which agent they ran", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-lb-"));
    const domain = await loadDomain(example);
    const base = { domain, user: scriptedUser(), k: 1, taskIds: ["no-mc-number"], outDir: dir, entries: [{ label: "Careful rules", agent: "scripted:careful" }] };
    await runLeaderboard({ ...base, resolveAgent: async () => freightScriptedAgent("careful") });
    await rm(path.join(dir, "careful-rules", "run.json"));
    const seen: string[] = [];
    await runLeaderboard({ ...base, resolveAgent: async () => freightScriptedAgent("careful"), onEntry: (_l, status, note) => seen.push(`${status}: ${note}`) });
    expect(seen).toEqual(["ran: stored results not reused: they have no run.json, so their agent spec can't be checked"]);
    expect(JSON.parse(await readFile(path.join(dir, "careful-rules", "run.json"), "utf8"))).toMatchObject({ agent: "scripted:careful" });
  });

  it("skips a noop entry, since the do-nothing baseline is always there, and shows one pass column at k=1", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-lb-"));
    const domain = await loadDomain(example);
    const seen: string[] = [];
    const lb = await runLeaderboard({
      domain,
      entries: [{ label: "Careful rules", agent: "scripted:careful" }, { label: "Do nothing", agent: "noop" }],
      user: scriptedUser(),
      k: 1,
      outDir: dir,
      resolveAgent: async () => freightScriptedAgent("careful"),
      onEntry: (label, status) => seen.push(`${label}:${status}`),
    });
    expect(seen).toEqual(["Careful rules:ran", "Do nothing:skipped"]);
    expect(lb.rows.map((r) => r.label)).toEqual(["Careful rules", "Do-nothing baseline"]);
    const md = await readFile(path.join(dir, "LEADERBOARD.md"), "utf8");
    expect(md).toContain("on every task once");
    expect(md).toContain("| # | Model | pass^1 | Rule violations |");
    expect(md).toContain("| 1 | Careful rules | 100.0% | 0 |");
    expect(await readFile(path.join(dir, "leaderboard.html"), "utf8")).toContain("<th>Model</th><th>pass^1</th><th>Rule violations</th>");
  });

  it("shows a model whose trials crashed as an error, not as a 0% score", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-lb-"));
    const domain = await loadDomain(example);
    const broken: AgentAdapter = { name: "broken", createSession: async () => ({ reply: async () => { throw new Error("Failed to resolve AWS credentials"); } }) };
    const seen: string[] = [];
    const lb = await runLeaderboard({
      domain,
      entries: [{ label: "No credentials", agent: "broken" }],
      user: scriptedUser(),
      k: 1,
      taskIds: ["book-at-posted-rate", "no-mc-number"],
      outDir: dir,
      resolveAgent: async () => broken,
      onEntry: (label, status, note) => seen.push(`${label}:${status}: ${note}`),
    });
    expect(seen).toEqual(["No credentials:failed: 2 of 2 trial(s) crashed: Failed to resolve AWS credentials"]);
    expect(lb.rows.map((r) => [r.label, r.error ?? ""])).toEqual([
      ["Do-nothing baseline", ""],
      ["No credentials", "2 of 2 trial(s) crashed: Failed to resolve AWS credentials"],
    ]);
    expect(await readFile(path.join(dir, "LEADERBOARD.md"), "utf8")).toContain("|  | No credentials | error |  | 2 of 2 trial(s) crashed: Failed to resolve AWS credentials |  |  |");
  });

  it("rejects unknown task ids before running anything", async () => {
    const domain = await loadDomain(example);
    await expect(
      runLeaderboard({ domain, entries: [], user: scriptedUser(), k: 1, outDir: os.tmpdir(), taskIds: ["nope"], resolveAgent: async () => freightScriptedAgent("careful") }),
    ).rejects.toThrow(/unknown task id\(s\): nope/);
  });
});
