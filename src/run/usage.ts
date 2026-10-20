/** Token counts as the Anthropic API reports them: `input` excludes cache reads and cache writes. */
export interface TokenUsage {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
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
  return model.replace(/^(?:[a-z]{2,6}\.)?anthropic\./, "").replace(/-v\d+(?::\d+)?$/, "");
}

export function costOf(...groups: UsageByModel[]): number | null {
  let total = 0;
  for (const group of groups) {
    for (const [model, u] of Object.entries(group)) {
      const p = PRICES[model] ?? PRICES[priceKey(model)];
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
  }
  return t;
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}
