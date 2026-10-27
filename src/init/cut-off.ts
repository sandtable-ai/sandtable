import { DEFAULT_MODEL } from "../sim/claude.ts";

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
