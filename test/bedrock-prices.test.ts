import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

// scripts/bedrock-prices.mjs reads a saved Pricing API dump with --from, so these run offline.
// The usage types are spelled as the AWS Pricing API lists them for eu-west-1, in USD per 1K tokens.
const USAGE_TYPES: Record<string, number> = {
  "EU-Nova2.0Lite-input-tokens": 0.000374,
  "EU-Nova2.0Lite-input-tokens-batch": 0.000187,
  "EU-Nova2.0Lite-input-tokens-cross-region-global": 0.00034,
  "EU-Nova2.0Lite-input-tokens-cross-region-global-batch": 0.00017,
  "EU-Nova2.0Lite-input-tokens-flex-cross-region-global": 0.00017,
  "EU-Nova2.0Lite-input-tokens-priority-cross-region-global": 0.000595,
  "EU-Nova2.0Lite-output-tokens": 0.003157,
  "EU-Nova2.0Lite-output-tokens-cross-region-global": 0.00287,
  "EU-Nova2.0Lite-output-tokens-flex-cross-region-global": 0.001435,
  "EU-Nova2.0Lite-cache-read-input-token-count": 0.0000935,
  "EU-Nova2.0Lite-cache-read-input-token-count-cross-region-global": 0.000085,
  "EU-Nova2.0Lite-cache-write-input-token-count-cross-region-global": 0,
  "EU-Nova2.0Pro-text-input-tokens-cross-region-global": 0.00143,
  "EU-Nova2.0Pro-text-output-tokens-cross-region-global": 0.01147,
  "EU-NovaLite-input-tokens": 0.000069,
  "EU-NovaLite-output-tokens": 0.000276,
  "EU-gpt-oss-120b-input-tokens": 0.00018,
  "EU-gpt-oss-120b-output-tokens": 0.0007,
  "EU-openai.gpt-oss-120b-mantle-input-tokens-standard": 0.00018,
  "EU-openai.gpt-oss-120b-mantle-output-tokens-standard": 0.0007,
  "EU-openai.gpt-oss-safeguard-120b-mantle-input-tokens-standard": 0.00015,
  "EU-openai.gpt-oss-safeguard-120b-mantle-output-tokens-standard": 0.0006,
  "EU-xai.grok-4.6-mantle-input-tokens-global-standard": 0.0019,
  "EU-xai.grok-4.6-mantle-output-tokens-global-standard": 0.0059,
  "EU-xai.grok-4.7-mantle-input-tokens-global-standard": 0.002,
  "EU-xai.grok-4.7-mantle-input-tokens-global-flex": 0.001,
  "EU-xai.grok-4.7-mantle-input-tokens-standard": 0.0022,
  "EU-xai.grok-4.7-mantle-output-tokens-global-standard": 0.006,
  "EU-xai.grok-4.7-mantle-cache-read-tokens-global-standard": 0.0005,
  "EU-moonshotai.kimi-k2.5-mantle-input-tokens-standard": 0.00072,
  "EU-moonshotai.kimi-k2.5-mantle-output-tokens-standard": 0.0036,
  "EU-moonshotai.kimi-k3-mantle-input-tokens-global-standard": 0.003,
  "EU-moonshotai.kimi-k3-mantle-output-tokens-global-standard": 0.015,
  "EU-moonshotai.kimi-k3-mantle-cache-read-tokens-global-standard": 0.0003,
  "EU-moonshotai.kimi-k3-mantle-cache-write-tokens-30m-global-standard": 0.00375,
  "EU-qwen.qwen3-next-80b-a3b-instruct-mantle-input-tokens-standard": 0.000168,
  "EU-qwen.qwen3-next-80b-a3b-instruct-mantle-output-tokens-standard": 0.00144,
  "EU-Qwen3Next-80B-A3B-input-tokens-flex": 0.00009,
  "EU-Qwen3Next-80B-A3B-output-tokens-flex": 0.00071,
  "EU-zai.glm5-mantle-input-tokens-standard": 0.0012,
  "EU-zai.glm5-mantle-output-tokens-standard": 0.00384,
  "EU-example.tiny-model-input-tokens-flex": 0.0001,
  "EU-example.tiny-model-output-tokens-flex": 0.0004,
};

interface PricesFile {
  prices: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number; usageTypes: Record<string, string> }>;
  unresolved: Record<string, string>;
}

const MODELS = [
  "global.amazon.nova-2-lite-v1:0",
  "eu.amazon.nova-2-lite-v1:0",
  "amazon.nova-lite-v1:0",
  "openai.gpt-oss-120b-1:0",
  "global.xai.grok-4.7",
  "global.moonshotai.kimi-k3",
  "qwen.qwen3-next-80b-a3b",
  "global.zai.glm-5.3",
  "global.openai.gpt-5.5",
  "example.tiny-model-v1:0",
];

let out: PricesFile;
let stderr: string;
beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sandtable-prices-"));
  const dump = path.join(dir, "get-products.json");
  const item = (usagetype: string, usd: number) =>
    JSON.stringify({
      product: { attributes: { usagetype } },
      terms: { OnDemand: { T: { priceDimensions: { D: { unit: "1K tokens", pricePerUnit: { USD: usd.toFixed(10) } } } } } },
    });
  writeFileSync(dump, JSON.stringify({ PriceList: Object.entries(USAGE_TYPES).map(([t, usd]) => item(t, usd)) }));
  const script = path.resolve("scripts/bedrock-prices.mjs");
  const res = await promisify(execFile)(process.execPath, [script, "--from", dump, "eu-west-1", ...MODELS]);
  out = JSON.parse(res.stdout) as PricesFile;
  stderr = res.stderr;
});

describe("scripts/bedrock-prices.mjs", () => {
  it("resolves Nova 2 Lite, whose usage types spell it Nova2.0Lite, at the global cross-region price", () => {
    expect(out.prices["global.amazon.nova-2-lite-v1:0"]).toEqual({
      input: 0.34,
      output: 2.87,
      cacheRead: 0.085,
      cacheWrite: 0,
      usageTypes: {
        input: "EU-Nova2.0Lite-input-tokens-cross-region-global",
        output: "EU-Nova2.0Lite-output-tokens-cross-region-global",
        cacheRead: "EU-Nova2.0Lite-cache-read-input-token-count-cross-region-global",
        cacheWrite: "EU-Nova2.0Lite-cache-write-input-token-count-cross-region-global",
      },
    });
  });

  it("prices an in-region profile from the in-region usage types", () => {
    expect(out.prices["eu.amazon.nova-2-lite-v1:0"]).toMatchObject({
      input: 0.374,
      output: 3.157,
      usageTypes: { input: "EU-Nova2.0Lite-input-tokens", output: "EU-Nova2.0Lite-output-tokens" },
    });
  });

  it("does not read another model or version as the one asked for", () => {
    expect(out.prices["amazon.nova-lite-v1:0"]!.usageTypes).toEqual({ input: "EU-NovaLite-input-tokens", output: "EU-NovaLite-output-tokens" });
    expect(out.unresolved["global.zai.glm-5.3"]).toBe("no eu-west-1 usage type names glm-5.3: the Pricing API doesn't list this model here");
  });

  it("resolves the models it resolved before to the same usage types", () => {
    const types = (model: string) => out.prices[model]!.usageTypes;
    expect(types("openai.gpt-oss-120b-1:0")).toEqual({
      input: "EU-openai.gpt-oss-120b-mantle-input-tokens-standard",
      output: "EU-openai.gpt-oss-120b-mantle-output-tokens-standard",
    });
    expect(types("global.xai.grok-4.7")).toEqual({
      input: "EU-xai.grok-4.7-mantle-input-tokens-global-standard",
      output: "EU-xai.grok-4.7-mantle-output-tokens-global-standard",
      cacheRead: "EU-xai.grok-4.7-mantle-cache-read-tokens-global-standard",
    });
    expect(types("global.moonshotai.kimi-k3")).toEqual({
      input: "EU-moonshotai.kimi-k3-mantle-input-tokens-global-standard",
      output: "EU-moonshotai.kimi-k3-mantle-output-tokens-global-standard",
      cacheRead: "EU-moonshotai.kimi-k3-mantle-cache-read-tokens-global-standard",
      cacheWrite: "EU-moonshotai.kimi-k3-mantle-cache-write-tokens-30m-global-standard",
    });
    expect(types("qwen.qwen3-next-80b-a3b")).toEqual({
      input: "EU-qwen.qwen3-next-80b-a3b-instruct-mantle-input-tokens-standard",
      output: "EU-qwen.qwen3-next-80b-a3b-instruct-mantle-output-tokens-standard",
    });
    expect(out.prices["global.xai.grok-4.7"]).toMatchObject({ input: 2, output: 6, cacheRead: 0.5, cacheWrite: 2 });
  });

  it("says why a model has no price", () => {
    expect(out.unresolved["global.openai.gpt-5.5"]).toBe("no eu-west-1 usage type names gpt-5.5: the Pricing API doesn't list this model here");
    expect(out.unresolved["example.tiny-model-v1:0"]).toBe(
      "2 usage type(s) name tiny-model (e.g. EU-example.tiny-model-input-tokens-flex), but none is a standard on-demand input token price",
    );
    expect(Object.keys(out.prices)).not.toContain("global.openai.gpt-5.5");
    expect(stderr).toContain("  global.openai.gpt-5.5: no eu-west-1 usage type names gpt-5.5");
  });
});
