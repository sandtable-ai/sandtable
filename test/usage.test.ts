import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { runSuite } from "../src/run/suite.ts";
import { costOf, percentile, recordInto, sumUsage, type UsageByModel } from "../src/run/usage.ts";
import { claudeAgent } from "../src/sim/claude.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import { loadDomain } from "../src/spec/load.ts";

describe("usage accounting", () => {
  it("accumulates per model and prices known models", () => {
    const g: UsageByModel = {};
    recordInto(g, "claude-opus-5-5", { input: 1_000_000, output: 100_000 });
    recordInto(g, "claude-opus-5-5", { cacheRead: 1_000_000, cacheWrite: 0 });
    expect(g["claude-opus-5-5"]).toEqual({ calls: 2, input: 1_000_000, output: 100_000, cacheRead: 1_000_000, cacheWrite: 0 });
    // $4 input + $2 output + $0.20 cache read
    expect(costOf(g)).toBeCloseTo(6.2);
  });

  it("returns null cost when a model has no known price", () => {
    const g: UsageByModel = {};
    recordInto(g, "my-local-model", { input: 10 });
    expect(costOf(g)).toBeNull();
  });

  it("sums trials by role", () => {
    const a = { agent: { m: { calls: 1, input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }, user: {}, costUsd: null };
    const total = sumUsage([a, a]);
    expect(total.agent.m).toEqual({ calls: 2, input: 2, output: 4, cacheRead: 6, cacheWrite: 8 });
  });

  it("computes nearest-rank percentiles", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 100], 95)).toBe(100);
  });
});

describe("usage in runs", () => {
  it("records Claude usage per trial and totals it on the suite", async () => {
    const response = {
      stop_reason: "end_turn",
      model: "claude-opus-5-5",
      content: [{ type: "text", text: "Can I get your MC number?" }],
      usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 },
    };
    const client = { beta: { messages: { create: async () => response } } } as unknown as Anthropic;
    const r = await runSuite({
      domain: await loadDomain(path.resolve("examples/freight")),
      agent: claudeAgent({ client }),
      user: scriptedUser(),
      taskIds: ["no-mc-number"],
    });
    const trial = r.tasks[0]!.trials[0]!;
    expect(trial.usage.agent["claude-opus-5-5"]).toMatchObject({ calls: 3, input: 3000, output: 150, cacheRead: 12000 });
    expect(trial.usage.costUsd).toBeCloseTo((3000 * 4 + 150 * 20 + 12000 * 0.2) / 1e6);
    expect(r.usage.costUsd).toBeCloseTo(trial.usage.costUsd!);
    expect(r.latency.agentTurnP50Ms).not.toBeNull();
    expect(trial.events.filter((e) => e.type === "agent").every((e) => typeof e.latencyMs === "number")).toBe(true);
  });
});
