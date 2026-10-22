/** Token counts as the Anthropic API reports them: `input` excludes cache reads and cache writes. */
export interface TokenUsage {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Calls whose reply stopped at the output-token limit (`max_tokens`), so it may be cut off. Set once one has. */
  maxTokensStops?: number;
  /**
   * Calls whose reply text held reasoning (`<think>`, `<reasoning>`, `<analysis>`…) that sandtable removed before the
   * other side heard it. Set once one has.
   */
  reasoningStripped?: number;
  /**
   * Replies that were nothing but reasoning, with no tool call, even after sandtable asked again: once the reasoning
   * was removed the other side heard silence. Set once one has.
   */
  emptyAfterStrip?: number;
}

export type UsageByModel = Record<string, TokenUsage>;

export interface Usage {
  agent: UsageByModel;
  user: UsageByModel;
  /** Estimated USD at list prices; null when a model has no known price. */
  costUsd: number | null;
}

/** Adapters call this after every model request. Custom adapters may ignore it. */
export type UsageRecorder = (model: string, usage: Partial<Omit<TokenUsage, "calls">>) => void;

/** List prices in USD per million tokens. Estimates only: check your own contract. */
export const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

/** The built-in Claude prices, all for Claude 4.5 models or later: what the geo-profile premium applies to. */
const BUILT_IN = new Set(Object.keys(PRICES));

/**
 * Bedrock's geo cross-region profiles (eu., us., apac. …) bill Claude 4.5 models and later at 1.1× the global
 * price: "Regional and multi-region endpoints include a 10% premium over global endpoints"
 * (https://platform.claude.com/docs/en/about-claude/pricing). Global profiles and the Anthropic API pay the list price.
 */
const GEO_PROFILE_PREMIUM = 1.1;

/**
 * The price of a model ID as an adapter records it: an exact entry (from --prices) first, else the built-in
 * price, times GEO_PROFILE_PREMIUM for a Claude geo profile such as eu.anthropic.claude-opus-5-5.
 */
function priceOf(model: string): (typeof PRICES)[string] | undefined {
  const exact = PRICES[model];
  if (exact) return exact;
  const key = priceKey(model);
  const base = PRICES[key];
  if (!base) return undefined;
  const geo = /^([a-z]{2,6}(?:-[a-z]+)?)\.anthropic\./.exec(model)?.[1];
  if (!geo || geo === "global" || !BUILT_IN.has(key)) return base;
  const k = GEO_PROFILE_PREMIUM;
  return { input: base.input * k, output: base.output * k, cacheRead: base.cacheRead * k, cacheWrite: base.cacheWrite * k };
}

export function emptyUsage(): Usage {
  return { agent: {}, user: {}, costUsd: 0 };
}

export function recordInto(target: UsageByModel, model: string, u: Partial<Omit<TokenUsage, "calls">>): void {
  const t = (target[model] ??= { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  t.calls++;
  t.input += u.input ?? 0;
  t.output += u.output ?? 0;
  t.cacheRead += u.cacheRead ?? 0;
  t.cacheWrite += u.cacheWrite ?? 0;
  addCounts(t, u);
}

/** Adds `maxTokensStops`, `reasoningStripped` and `emptyAfterStrip`, each absent while no call has counted. */
function addCounts(t: TokenUsage, u: Partial<Pick<TokenUsage, "maxTokensStops" | "reasoningStripped" | "emptyAfterStrip">>): void {
  if (u.maxTokensStops) t.maxTokensStops = (t.maxTokensStops ?? 0) + u.maxTokensStops;
  if (u.reasoningStripped) t.reasoningStripped = (t.reasoningStripped ?? 0) + u.reasoningStripped;
  if (u.emptyAfterStrip) t.emptyAfterStrip = (t.emptyAfterStrip ?? 0) + u.emptyAfterStrip;
}

/**
 * Add or override prices, keyed by the model ID the adapter records (e.g. global.xai.grok-4.7).
 * Accepts the output of scripts/bedrock-prices.mjs ({ prices: {...} }) or a plain map.
 */
export function registerPrices(file: unknown): string[] {
  const map = (file && typeof file === "object" && "prices" in file ? (file as { prices: unknown }).prices : file) as Record<string, Record<string, unknown>>;
  const added: string[] = [];
  for (const [model, p] of Object.entries(map ?? {})) {
    const nums = ["input", "output", "cacheRead", "cacheWrite"].map((k) => Number(p?.[k]));
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) throw new Error(`price for ${model} needs numeric input, output, cacheRead and cacheWrite (USD per million tokens)`);
    const [input, output, cacheRead, cacheWrite] = nums as [number, number, number, number];
    PRICES[model] = { input, output, cacheRead, cacheWrite };
    added.push(model);
  }
  return added;
}

/** Map provider-specific IDs (anthropic.claude-…, us.anthropic.claude-…-v1:0) to the price-table key. */
export function priceKey(model: string): string {
  return model.replace(/^(?:[a-z]{2,6}(?:-[a-z]+)?\.)?anthropic\./, "").replace(/-v\d+(?::\d+)?$/, "");
}

export function costOf(...groups: UsageByModel[]): number | null {
  let total = 0;
  for (const group of groups) {
    for (const [model, u] of Object.entries(group)) {
      const p = priceOf(model);
      if (!p) return null;
      total += (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1e6;
    }
  }
  return total;
}

export function sumUsage(items: readonly Usage[]): Usage {
  const out = emptyUsage();
  for (const item of items) {
    for (const role of ["agent", "user"] as const) {
      for (const [model, u] of Object.entries(item[role])) {
        const t = (out[role][model] ??= { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        t.calls += u.calls;
        t.input += u.input;
        t.output += u.output;
        t.cacheRead += u.cacheRead;
        t.cacheWrite += u.cacheWrite;
        addCounts(t, u);
      }
    }
  }
  out.costUsd = costOf(out.agent, out.user);
  return out;
}

export function totalTokens(group: UsageByModel): TokenUsage {
  const t: TokenUsage = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const u of Object.values(group)) {
    t.calls += u.calls;
    t.input += u.input;
    t.output += u.output;
    t.cacheRead += u.cacheRead;
    t.cacheWrite += u.cacheWrite;
    addCounts(t, u);
  }
  return t;
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}
