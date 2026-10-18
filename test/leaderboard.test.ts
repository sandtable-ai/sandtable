import { mkdtemp, readFile } from "node:fs/promises";
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
    expect(lb.rows.find((r) => r.baseline)!.passHatK).toBeCloseTo(0.5);
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
});
