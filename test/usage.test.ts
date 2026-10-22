import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { runSuite } from "../src/run/suite.ts";
import { costOf, percentile, recordInto, registerPrices, sumUsage, totalTokens, type UsageByModel } from "../src/run/usage.ts";
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

  it("prices Claude on a Bedrock geo profile at 1.1× the global price, and an exact --prices entry as given", () => {
    const million = (model: string): UsageByModel => ({ [model]: { calls: 1, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } });
    // Opus 5.5 input is $4 per million at the global rate.
    for (const model of ["claude-opus-5-5", "global.anthropic.claude-opus-5-5"]) expect(costOf(million(model)), model).toBeCloseTo(4);
    for (const model of ["eu.anthropic.claude-opus-5-5", "us.anthropic.claude-opus-5-5", "apac.anthropic.claude-opus-5-5-v1:0", "us-gov.anthropic.claude-opus-5-5"]) {
      expect(costOf(million(model)), model).toBeCloseTo(4.4);
    }
    // Unverified: an in-region (or Mantle) anthropic. ID keeps the built-in price, since the pricing page doesn't say how it bills.
    expect(costOf(million("anthropic.claude-opus-5-5"))).toBeCloseTo(4);
    // Every token kind carries the premium.
    expect(costOf({ "eu.anthropic.claude-haiku-5-5": { calls: 1, input: 0, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 } })).toBeCloseTo((0.5 + 0.01 + 0.125) * 1.1);
    // A price registered for the exact profile ID wins, and a model the built-in table doesn't hold gets no premium.
    registerPrices({ "us.anthropic.claude-sonnet-5-5": { input: 2.5, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, "claude-3-haiku": { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 } });
    expect(costOf(million("us.anthropic.claude-sonnet-5-5"))).toBeCloseTo(2.5);
    expect(costOf(million("us.anthropic.claude-3-haiku"))).toBeCloseTo(0.25);
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

  it("counts replies with reasoning removed and replies left silent, with no count until one has", () => {
    const g: UsageByModel = {};
    recordInto(g, "m", { output: 10 });
    expect(g.m).not.toHaveProperty("emptyAfterStrip");
    recordInto(g, "m", { output: 20, reasoningStripped: 1, emptyAfterStrip: 1 });
    expect(g.m).toMatchObject({ calls: 2, reasoningStripped: 1, emptyAfterStrip: 1 });
    const trial = { agent: g, user: {}, costUsd: null };
    expect(sumUsage([trial, trial]).agent.m).toMatchObject({ calls: 4, reasoningStripped: 2, emptyAfterStrip: 2 });
    expect(totalTokens({ a: g.m!, b: g.m! })).toMatchObject({ calls: 4, emptyAfterStrip: 2 });
  });

  it("counts calls that stopped at max_tokens, with no count until one has", () => {
    const g: UsageByModel = {};
    recordInto(g, "m", { output: 10 });
    expect(g.m).not.toHaveProperty("maxTokensStops");
    recordInto(g, "m", { output: 16000, maxTokensStops: 1 });
    expect(g.m).toMatchObject({ calls: 2, maxTokensStops: 1 });
    const trial = { agent: g, user: {}, costUsd: null };
    expect(sumUsage([trial, trial]).agent.m).toMatchObject({ calls: 4, maxTokensStops: 2 });
    expect(totalTokens({ a: g.m!, b: { calls: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })).toMatchObject({ calls: 3, maxTokensStops: 1 });
    expect(sumUsage([{ agent: { m: { calls: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }, user: {}, costUsd: null }]).agent.m).not.toHaveProperty("maxTokensStops");
  });

  it("counts calls whose reasoning was removed, with no count until one has", () => {
    const g: UsageByModel = {};
    recordInto(g, "m", { output: 10 });
    expect(g.m).not.toHaveProperty("reasoningStripped");
    recordInto(g, "m", { output: 10, reasoningStripped: 1 });
    expect(g.m).toMatchObject({ calls: 2, reasoningStripped: 1 });
    const trial = { agent: g, user: {}, costUsd: null };
    expect(sumUsage([trial, trial]).agent.m).toMatchObject({ calls: 4, reasoningStripped: 2 });
    expect(totalTokens({ a: g.m!, b: { calls: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })).toMatchObject({ calls: 3, reasoningStripped: 1 });
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

describe("registerPrices", () => {
  it("adds prices from the bedrock-prices script output, keyed by exact model ID", () => {
    registerPrices({ prices: { "global.xai.grok-4.7": { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 2, usageTypes: {} } } });
    const g: UsageByModel = {};
    recordInto(g, "global.xai.grok-4.7", { input: 1_000_000, output: 1_000_000 });
    expect(costOf(g)).toBeCloseTo(8);
  });

  it("rejects incomplete prices", () => {
    expect(() => registerPrices({ "m": { input: 1 } })).toThrow(/needs numeric input, output, cacheRead and cacheWrite/);
  });
});
