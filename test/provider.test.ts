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
    expect(resolveModel("claude-opus-5-5", "bedrock", { region: "eu-west-1" })).toBe("eu.anthropic.claude-opus-5-5");
    expect(resolveModel("claude-haiku-5-5", "bedrock", { region: "us-east-1" })).toBe("us.anthropic.claude-haiku-5-5");
    expect(resolveModel("claude-haiku-5-5", "bedrock", { region: "ap-southeast-2" })).toBe("apac.anthropic.claude-haiku-5-5");
    expect(resolveModel("claude-opus-5-5", "bedrock", { region: "us-east-1", bedrockClient: "mantle" })).toBe("anthropic.claude-opus-5-5");
    expect(resolveModel("us.anthropic.claude-sonnet-5-5", "bedrock")).toBe("us.anthropic.claude-sonnet-5-5");
    expect(resolveModel("arn:aws:bedrock:eu-west-1:123:inference-profile/x", "bedrock")).toMatch(/^arn:/);
  });

  it("never sends server-side fallbacks to Bedrock", () => {
    expect(requestBase({}, "low")).toMatchObject({ fallbacks: "default" });
    const bedrock = requestBase({ provider: "bedrock", region: "eu-west-1" }, "low");
    expect(bedrock).not.toHaveProperty("fallbacks");
    expect(bedrock).toMatchObject({ model: "eu.anthropic.claude-opus-5-5", cache_control: { type: "ephemeral" }, output_config: { effort: "low" } });
  });

  it("builds either Bedrock client with the messages surface sandtable uses", async () => {
    for (const bedrockClient of ["classic", "mantle"] as const) {
      const client = await createClient({ provider: "bedrock", region: "eu-west-1", awsProfile: "example", bedrockClient });
      expect(typeof client.beta.messages.create).toBe("function");
      expect(typeof client.beta.messages.parse).toBe("function");
    }
  });

  it("prices provider-specific model IDs with the same table", () => {
    expect(priceKey("us.anthropic.claude-haiku-5-5-v1:0")).toBe("claude-haiku-5-5");
    expect(priceKey("anthropic.claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(priceKey("eu.anthropic.claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(priceKey("us-gov.anthropic.claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(costOf({ "anthropic.claude-opus-5-5": { calls: 1, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } })).toBeCloseTo(4);
  });
});
