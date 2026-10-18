#!/usr/bin/env node
// Resolve on-demand Amazon Bedrock prices for model IDs from the AWS Pricing API.
//
//   AWS_PROFILE=... node scripts/bedrock-prices.mjs <region> <model-id>... > prices/bedrock.<region>.json
//   node scripts/bedrock-prices.mjs --from <get-products.json> <region> <model-id>...   (offline, from a saved dump)
//
// Output: { region, source, generatedAt, prices: { <model-id>: { input, output, cacheRead, cacheWrite, usageTypes } } }
// in USD per million tokens. Models that cannot be resolved are listed under `unresolved`, never guessed.
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

function pick(types, kind, global) {
  const want = types.filter((t) => t.includes(kind) && !/-(batch|flex|priority)$/.test(t) && !/-(global-)?(batch|flex|priority)$/.test(t));
  const scoped = want.filter((t) => (global ? t.includes("-global-") : !t.includes("-global-")));
  const pool = scoped.length ? scoped : want;
  // Prefer explicit "standard", then the shortest usage type (no extra qualifiers).
  return pool.sort((a, b) => Number(b.endsWith("standard")) - Number(a.endsWith("standard")) || a.length - b.length)[0];
}

const prices = {};
const unresolved = [];
for (const model of models) {
  const key = core(model);
  const types = [...perK.keys()].filter((t) => t.toLowerCase().includes(key));
  const global = model.startsWith("global.");
  const input = pick(types, "input-tokens", global);
  const output = pick(types, "output-tokens", global);
  if (!input || !output) {
    unresolved.push(model);
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
if (unresolved.length) console.error(`unresolved (cost will show n/a): ${unresolved.join(", ")}`);
