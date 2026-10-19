#!/usr/bin/env node
// Resolve on-demand Amazon Bedrock prices for model IDs from the AWS Pricing API.
//
//   AWS_PROFILE=... node scripts/bedrock-prices.mjs <region> <model-id>... > prices/bedrock.<region>.json
//   node scripts/bedrock-prices.mjs --from <get-products.json> <region> <model-id>...   (offline, from a saved dump)
//
// Output: { region, source, generatedAt, prices: { <model-id>: { input, output, cacheRead, cacheWrite, usageTypes } } }
// in USD per million tokens. Models that cannot be resolved are listed under `unresolved` with the reason, never guessed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
let from;
if (argv[0] === "--from") {
  from = argv[1];
  argv.splice(0, 2);
}
const [region, ...models] = argv;
if (!region || models.length === 0) {
  console.error("usage: bedrock-prices.mjs [--from dump.json] <region> <model-id>...");
  process.exit(2);
}

const raw = from
  ? readFileSync(from, "utf8")
  : execFileSync(
      "aws",
      ["pricing", "get-products", "--region", "us-east-1", "--service-code", "AmazonBedrock", "--filters", `Type=TERM_MATCH,Field=regionCode,Value=${region}`, "--output", "json"],
      { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
    );

/** usagetype -> USD per 1K tokens (on-demand). */
const perK = new Map();
for (const s of JSON.parse(raw).PriceList) {
  const item = JSON.parse(s);
  const ut = item.product?.attributes?.usagetype;
  if (!ut) continue;
  for (const term of Object.values(item.terms?.OnDemand ?? {})) {
    for (const pd of Object.values(term.priceDimensions)) {
      if (pd.unit === "1K tokens") perK.set(ut, Number(pd.pricePerUnit.USD));
    }
  }
}

function core(modelId) {
  const noGeo = modelId.replace(/^(global|us|eu|apac|jp|au)\./, "");
  const noProvider = noGeo.includes(".") ? noGeo.slice(noGeo.indexOf(".") + 1) : noGeo;
  return noProvider.replace(/-v\d+(:\d+)?$/, "").replace(/-\d+:\d+$/, "").toLowerCase();
}

/**
 * The words of a model ID or usage type, lower-cased: split at separators, between letters and digits
 * and at camelCase, with a version's trailing ".0" dropped. Model IDs and usage types spell the same
 * model differently: `nova-2-lite` and `Nova2.0Lite` both read as nova 2 lite.
 */
function words(s) {
  return s
    .replace(/(\d)\.0+(?!\d)/g, "$1")
    .replace(/(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/g, "-")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The usage type names the model: the model's words appear in it, in order and next to each other. */
function names(type, key) {
  const t = words(type);
  return t.some((_, i) => key.every((w, j) => t[i + j] === w));
}

function pick(types, kind, global) {
  const want = types.filter((t) => {
    const w = words(t);
    if (w.includes("batch") || w.includes("flex") || w.includes("priority")) return false;
    return t.toLowerCase().includes(kind) && (kind.startsWith("cache") || !t.toLowerCase().includes("cache"));
  });
  // Global profiles are priced under usage types marked global (`-global-standard`, `-cross-region-global`).
  const scoped = want.filter((t) => words(t).includes("global") === global);
  const pool = scoped.length ? scoped : want;
  // Prefer explicit "standard", then the shortest usage type (no extra qualifiers).
  return pool.sort((a, b) => Number(b.endsWith("standard")) - Number(a.endsWith("standard")) || a.length - b.length)[0];
}

const prices = {};
/** model ID -> why it has no price. */
const unresolved = {};
for (const model of models) {
  const key = core(model);
  const types = [...perK.keys()].filter((t) => names(t, words(key)));
  const global = model.startsWith("global.");
  const input = pick(types, "input-tokens", global);
  const output = pick(types, "output-tokens", global);
  if (!input || !output) {
    unresolved[model] = types.length
      ? `${types.length} usage type(s) name ${key} (e.g. ${types[0]}), but none is a standard on-demand ${input ? "output" : "input"} token price`
      : `no ${region} usage type names ${key}: the Pricing API doesn't list this model here`;
    continue;
  }
  const cacheRead = pick(types, "cache-read", global);
  const cacheWrite = pick(types, "cache-write", global);
  const m = (t) => (t ? Math.round(perK.get(t) * 1000 * 1e6) / 1e6 : undefined);
  prices[model] = {
    input: m(input),
    output: m(output),
    cacheRead: m(cacheRead) ?? m(input),
    cacheWrite: m(cacheWrite) ?? m(input),
    usageTypes: { input, output, ...(cacheRead ? { cacheRead } : {}), ...(cacheWrite ? { cacheWrite } : {}) },
  };
}

process.stdout.write(
  `${JSON.stringify({ region, source: "AWS Pricing API (AmazonBedrock, on-demand)", generatedAt: new Date().toISOString(), prices, unresolved }, null, 2)}\n`,
);
const missing = Object.entries(unresolved);
if (missing.length) console.error(`unresolved (cost will show n/a):\n${missing.map(([model, why]) => `  ${model}: ${why}`).join("\n")}`);
