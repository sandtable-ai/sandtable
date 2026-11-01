import { DEFAULT_MODEL } from "../sim/claude.ts";

/**
 * The most a drafting call for an SOP may write, thinking included. An SOP's reply lists every rule, then an invariant
 * or a soft rule for each, so it runs longer than a transcript's: a long policy came close to the 16,000 a transcript's
 * call keeps.
 */
export const SOP_MAX_TOKENS = 32000;

/**
 * How long the SOP's call may take. Given no timeout, the SDK refuses a call that may write SOP_MAX_TOKENS without
 * streaming, as one that may take longer than 10 minutes; this is its own estimate for that many tokens.
 */
export const SOP_TIMEOUT_MS = (60 * 60_000 * SOP_MAX_TOKENS) / 128_000;

/**
 * A structured-output format whose parse yields null for a reply that isn't its JSON, such as one cut off at
 * max_tokens, where the SDK's own parse would throw: the caller then has the response, its stop reason and its usage,
 * to say why and what the call cost.
 */
export function lenient<T>(format: { type: "json_schema"; schema: Record<string, unknown>; parse: (content: string) => T }) {
  return {
    ...format,
    parse: (content: string): T | null => {
      try {
        return format.parse(content);
      } catch {
        return null;
      }
    },
  };
}

/**
 * When a drafting reply stopped at max_tokens, how far it got, for the error or warning that says so: a model can
 * spend the whole limit thinking, at the drafting steps' effort, and write no answer. Undefined for any other reply.
 */
export function cutOff(response: { stop_reason?: string | null; content?: readonly { type: string }[] }, maxTokens: number): string | undefined {
  if (response.stop_reason !== "max_tokens") return undefined;
  const thinkingOnly = (response.content ?? []).every((b) => b.type === "thinking" || b.type === "redacted_thinking");
  return `the reply hit the ${maxTokens}-token output limit ${thinkingOnly ? "while thinking, before it wrote anything" : "before it finished"}`;
}

/**
 * What to try after a cut-off reply: the next larger model, or a shorter document on the largest. A model ID that
 * names none of them, such as an inference-profile ARN, gets both.
 */
export function cutOffHint(model: string, document: string): string {
  if (/haiku/.test(model)) return "Try a larger model, such as -m claude-sonnet-5-5.";
  if (/sonnet/.test(model)) return `Try a larger model, such as -m ${DEFAULT_MODEL}, the default.`;
  if (/opus/.test(model)) return `Try a shorter ${document}.`;
  return `Try a larger model, or a shorter ${document}.`;
}
