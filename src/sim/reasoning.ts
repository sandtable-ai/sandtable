/**
 * Reasoning that some models write into their reply text instead of a separate field: `<think>` (Qwen,
 * DeepSeek), `<thinking>`, `<reasoning>` or `<analysis>` (gpt-oss) blocks. The other side of the conversation
 * must never hear it: the agent's reasoning can state values it must not disclose, and a simulated caller's
 * can quote its hidden instructions. Graders read what the other side heard, so it would be scored as speech.
 */
const TAGS = "think|thinking|reasoning|analysis";
const BLOCK = new RegExp(`<(${TAGS})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1\\s*>`, "gi");
const OPENING = new RegExp(`<(?:${TAGS})(?:\\s[^>]*)?>`, "i");
const CLOSING = new RegExp(`<\\/(?:${TAGS})\\s*>`, "gi");

/** The text without its closed reasoning blocks, removed until none is left, so nested ones go too. */
function withoutClosedBlocks(text: string): string {
  let out = text;
  for (let before = ""; before !== out; ) {
    before = out;
    out = out.replace(BLOCK, "");
  }
  return out;
}

/**
 * The text a model's reply says out loud: every reasoning block removed. Besides closed blocks, a closing tag
 * with no opening one ends reasoning that began before the reply (some chat templates open `<think>` for the
 * model), so everything up to it goes; and an opening tag that is never closed starts reasoning that runs to the
 * end of the reply, so everything from it goes.
 */
export function stripReasoning(text: string): string {
  let out = withoutClosedBlocks(text);
  const closings = [...out.matchAll(CLOSING)];
  const last = closings.at(-1);
  if (last) out = out.slice(last.index + last[0].length);
  const open = OPENING.exec(out);
  if (open) out = out.slice(0, open.index);
  return out.trim();
}

/** Whether the text holds any reasoning that stripReasoning removes. */
export function hasReasoning(text: string): boolean {
  return OPENING.test(text) || new RegExp(CLOSING.source, "i").test(text);
}

/** Whether a reasoning block opens and never closes: the reasoning and the answer can't be told apart. */
export function hasUnclosedReasoning(text: string): boolean {
  return OPENING.test(withoutClosedBlocks(text));
}

/** Whether the text is nothing but reasoning: it holds some, and stripReasoning leaves nothing to say. */
export function onlyReasoning(text: string): boolean {
  return hasReasoning(text) && stripReasoning(text) === "";
}

/**
 * How many times an adapter asks again for a reply it can't use as it is: one whose reasoning never closes, or one
 * that is nothing but reasoning, which the other side would hear as silence. The discarded replies never enter the
 * conversation.
 */
export const REASONING_RETRIES = 2;
