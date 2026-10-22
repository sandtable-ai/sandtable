import { DEFAULT_MODEL, providerOf, requestBase, type ClaudeOptions, type Provider } from "../sim/claude.ts";
import { costOf } from "../run/usage.ts";
import { SOP_SYSTEM_PROMPT } from "./sop.ts";
import { TRANSCRIPTS_SYSTEM_PROMPT } from "./transcripts.ts";

/**
 * What `init --sop` and `--transcripts` will spend, worked out before any model call and without credentials,
 * a client or the Bedrock package: `init --dry-run` prints it and stops, and a real run prints it first.
 */
export interface DraftPlan {
  sopCalls: number;
  transcriptCalls: number;
  /** The model as asked for (`-m`, else the default). */
  model: string;
  /** The ID the request will name: on Bedrock, the region's inference profile. */
  resolved: string;
  provider: Provider;
  region?: string;
  /** Input tokens across every call, estimated from the prompt sizes. */
  inputTokens: number;
  /** The most output every call together may write: max_tokens per call. */
  outputTokens: number;
  /** The upper bound in USD at list prices; null when the model has no known price. */
  costUsd: number | null;
}

/**
 * The structured-output schema and request framing aren't in the prompt text: count them as this many tokens per
 * call, a generous figure for the drafting schemas, so the bound stays an upper bound.
 */
const SCHEMA_TOKENS = 3000;

/** About 4 characters per token for English text and YAML: rounded up, so the estimate errs high. */
const tokens = (chars: number) => Math.ceil(chars / 4);

/**
 * The plan for drafting from an SOP and transcripts into a domain whose files hold `domainChars` characters. Each
 * call sends the system prompt, the schema, the domain and one document, and may write up to max_tokens. Input is
 * priced at the cache-write rate, the highest input rate, since the shared prefix is cached as it is first sent.
 */
export function draftPlan(input: { domainChars: number; sopChars?: number; transcriptChars: readonly number[]; claude: ClaudeOptions }): DraftPlan {
  const base = requestBase(input.claude, "high");
  const provider = providerOf(input.claude);
  const region = provider === "bedrock" ? (input.claude.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION) : undefined;
  const sopCalls = input.sopChars === undefined ? 0 : 1;
  const transcriptCalls = input.transcriptChars.length;
  const sopInput = sopCalls ? tokens(SOP_SYSTEM_PROMPT.length + input.domainChars + input.sopChars!) + SCHEMA_TOKENS : 0;
  const transcriptInput = input.transcriptChars.reduce((n, chars) => n + tokens(TRANSCRIPTS_SYSTEM_PROMPT.length + input.domainChars + chars) + SCHEMA_TOKENS, 0);
  const calls = sopCalls + transcriptCalls;
  const inputTokens = sopInput + transcriptInput;
  const outputTokens = calls * base.max_tokens;
  const costUsd = costOf({ [base.model]: { calls, input: 0, output: outputTokens, cacheRead: 0, cacheWrite: inputTokens } });
  return {
    sopCalls,
    transcriptCalls,
    model: input.claude.model ?? DEFAULT_MODEL,
    resolved: base.model,
    provider,
    ...(region ? { region } : {}),
    inputTokens,
    outputTokens,
    costUsd,
  };
}

/** "Plan: 10 model calls (1 for the SOP, 9 for transcripts) to claude-sonnet-5-5 on Bedrock (eu-west-1, eu.anthropic.claude-sonnet-5-5); at most about $2.43 at list prices" */
export function planLine(p: DraftPlan): string {
  const calls = p.sopCalls + p.transcriptCalls;
  const parts = [p.sopCalls ? "1 for the SOP" : "", p.transcriptCalls ? `${p.transcriptCalls} for transcripts` : ""].filter(Boolean).join(", ");
  const where =
    p.provider === "bedrock"
      ? `Bedrock (${[p.region ?? "region from your AWS config", p.resolved !== p.model ? p.resolved : ""].filter(Boolean).join(", ")})`
      : "the Anthropic API";
  const cost = p.costUsd === null ? `cost unknown (no price for ${p.resolved})` : `at most about $${p.costUsd.toFixed(2)} at list prices`;
  return `Plan: ${calls} model call${calls === 1 ? "" : "s"} (${parts}) to ${p.model} on ${where}; ${cost}`;
}
