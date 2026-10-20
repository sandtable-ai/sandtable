import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  "EU-zai.glm-4.7-mantle-input-tokens-standard": 0.00072,
  "EU-zai.glm-4.7-mantle-output-tokens-standard": 0.00264,
  "EU-zai.glm-4.7-flash-mantle-input-tokens-standard": 0.00008,
  "EU-zai.glm-4.7-flash-mantle-output-tokens-standard": 0.00048,
  "EU-nvidia.nemotron-nano-9b-v2-mantle-input-tokens-standard": 0.00007,
  "EU-nvidia.nemotron-nano-9b-v2-mantle-output-tokens-standard": 0.00027,
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
  // Each a prefix of a listed model's name: never priced from that model.
  "global.xai.grok-4",
  "moonshotai.kimi-k2",
  "amazon.nova-2",
  "zai.glm-4",
  "zai.glm-4.7",
  "nvidia.nemotron-nano-9b-v2",
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
    expect(out.unresolved["global.zai.glm-5.3"]).toBe("no eu-west-1 usage type names glm-5.3");
  });

  it("never prices a model from another model's or version's usage types", () => {
    // A wrong price is worse than none: grok-4 is not grok-4.6, kimi-k2 is not kimi-k2.5,
    // nova-2 could be Nova 2 Lite or Pro, and glm-4.7 is not glm-4.7-flash.
    for (const model of ["global.xai.grok-4", "moonshotai.kimi-k2", "amazon.nova-2", "zai.glm-4"]) expect(out.prices[model], model).toBeUndefined();
    expect(out.unresolved["global.xai.grok-4"]).toBe("no eu-west-1 usage type names grok-4");
    expect(out.prices["zai.glm-4.7"]!.usageTypes).toEqual({
      input: "EU-zai.glm-4.7-mantle-input-tokens-standard",
      output: "EU-zai.glm-4.7-mantle-output-tokens-standard",
    });
    // A name that ends in -v2 is the model's name, not Bedrock's -v1:0 version suffix.
    expect(out.prices["nvidia.nemotron-nano-9b-v2"]!.usageTypes.input).toBe("EU-nvidia.nemotron-nano-9b-v2-mantle-input-tokens-standard");
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
    expect(out.unresolved["global.openai.gpt-5.5"]).toBe("no eu-west-1 usage type names gpt-5.5");
    expect(out.unresolved["example.tiny-model-v1:0"]).toBe(
      "2 usage type(s) name tiny-model (e.g. EU-example.tiny-model-input-tokens-flex), but none is a standard on-demand input token price",
    );
    expect(Object.keys(out.prices)).not.toContain("global.openai.gpt-5.5");
    expect(stderr).toContain("  global.openai.gpt-5.5: no eu-west-1 usage type names gpt-5.5");
  });

  it("takes a model the Pricing API can't price from --verified, with its source, and never overrides the Pricing API", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sandtable-prices-"));
    const dump = path.join(dir, "get-products.json");
    writeFileSync(dump, JSON.stringify({ PriceList: [] }));
    const verified = path.join(dir, "verified.json");
    const luna = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, source: "https://docs.aws.amazon.com/luna", row: "Global CRIS | $0.10 | ..." };
    writeFileSync(verified, JSON.stringify({ prices: { "global.openai.gpt-6-luna": luna, "global.xai.grok-4.7": { ...luna, source: "https://example.com/wrong" } } }));
    const script = path.resolve("scripts/bedrock-prices.mjs");
    const run = async (from: string) => JSON.parse((await promisify(execFile)(process.execPath, [script, "--from", from, "--verified", verified, "eu-west-1", "global.openai.gpt-6-luna", "global.xai.grok-4.7", "global.openai.gpt-6-astra"])).stdout) as PricesFile;

    const none = await run(dump);
    expect(none.prices["global.openai.gpt-6-luna"]).toEqual(luna);
    expect(none.unresolved).toEqual({ "global.openai.gpt-6-astra": "no eu-west-1 usage type names gpt-6-astra" });

    // Where the Pricing API has a price, it stands.
    const withGrok = path.join(dir, "with-grok.json");
    const item = (usagetype: string, usd: number) => JSON.stringify({ product: { attributes: { usagetype } }, terms: { OnDemand: { T: { priceDimensions: { D: { unit: "1K tokens", pricePerUnit: { USD: String(usd) } } } } } } });
    writeFileSync(withGrok, JSON.stringify({ PriceList: [item("EU-xai.grok-4.7-mantle-input-tokens-global-standard", 0.002), item("EU-xai.grok-4.7-mantle-output-tokens-global-standard", 0.006)] }));
    expect((await run(withGrok)).prices["global.xai.grok-4.7"]).toMatchObject({ input: 2, output: 6, usageTypes: { input: "EU-xai.grok-4.7-mantle-input-tokens-global-standard" } });
  });

  it("prices/bedrock.verified.json gives every entry four prices and the AWS page it came from", async () => {
    const { prices } = JSON.parse(readFileSync(path.resolve("prices/bedrock.verified.json"), "utf8")) as { prices: Record<string, Record<string, unknown>> };
    expect(Object.keys(prices).sort()).toEqual(["global.openai.gpt-6-astra", "global.openai.gpt-6-luna", "global.openai.gpt-6.1-sol"]);
    for (const [model, p] of Object.entries(prices)) {
      for (const k of ["input", "output", "cacheRead", "cacheWrite"]) expect(typeof p[k], `${model} ${k}`).toBe("number");
      expect(p.source, model).toMatch(/^https:\/\/docs\.aws\.amazon\.com\/bedrock\//);
      expect(p.row, model).toMatch(/Global CRIS/);
    }
  });
});
