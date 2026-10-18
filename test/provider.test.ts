import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, providerOf, requestBase, resolveModel } from "../src/sim/claude.ts";
import { costOf, priceKey } from "../src/run/usage.ts";

describe("providers", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to the Anthropic API and honours SANDTABLE_PROVIDER", () => {
    expect(providerOf({})).toBe("anthropic");
    vi.stubEnv("SANDTABLE_PROVIDER", "bedrock");
    expect(providerOf({})).toBe("bedrock");
    expect(providerOf({ provider: "anthropic" })).toBe("anthropic");
    vi.stubEnv("SANDTABLE_PROVIDER", "azure");
    expect(() => providerOf({})).toThrow(/unknown provider "azure"/);
  });

  it("maps model IDs for Bedrock and passes inference profiles and ARNs through", () => {
    expect(resolveModel("claude-opus-5-5", "anthropic")).toBe("claude-opus-5-5");
    expect(resolveModel("claude-opus-5-5", "bedrock")).toBe("anthropic.claude-opus-5-5");
    expect(resolveModel("us.anthropic.claude-sonnet-5-5", "bedrock")).toBe("us.anthropic.claude-sonnet-5-5");
    expect(resolveModel("arn:aws:bedrock:eu-west-1:123:inference-profile/x", "bedrock")).toMatch(/^arn:/);
  });

  it("never sends server-side fallbacks to Bedrock", () => {
    expect(requestBase({}, "low")).toMatchObject({ fallbacks: "default" });
    const bedrock = requestBase({ provider: "bedrock" }, "low");
    expect(bedrock).not.toHaveProperty("fallbacks");
    expect(bedrock).toMatchObject({ model: "anthropic.claude-opus-5-5", cache_control: { type: "ephemeral" }, output_config: { effort: "low" } });
  });

  it("builds a Bedrock client with the messages surface sandtable uses", async () => {
    const client = await createClient({ provider: "bedrock", region: "us-east-1" });
    expect(typeof client.beta.messages.create).toBe("function");
    expect(typeof client.beta.messages.parse).toBe("function");
  });

  it("prices provider-specific model IDs with the same table", () => {
    expect(priceKey("us.anthropic.claude-haiku-5-5-v1:0")).toBe("claude-haiku-5-5");
    expect(priceKey("anthropic.claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(costOf({ "anthropic.claude-opus-5-5": { calls: 1, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } })).toBeCloseTo(4);
  });
});
