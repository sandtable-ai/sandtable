import { importOptional } from "./optional.ts";
import { hasReasoning, hasUnclosedReasoning, onlyReasoning, REASONING_RETRIES, stripReasoning } from "./reasoning.ts";
import type { AgentAdapter } from "./types.ts";

/** The slice of BedrockRuntimeClient this adapter uses; injectable for tests. */
export interface ConverseClient {
  send(command: unknown): Promise<ConverseResponse>;
}

interface ConverseBlock {
  text?: string;
  toolUse?: { toolUseId: string; name: string; input: unknown };
  toolResult?: { toolUseId: string; content: { text: string }[]; status?: "success" | "error" };
  cachePoint?: { type: "default" };
}

interface ConverseMessage {
  role: "user" | "assistant";
  content: ConverseBlock[];
}

interface ConverseResponse {
  output?: { message?: ConverseMessage };
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number };
}

export interface BedrockConverseOptions {
  /** Bedrock model or inference profile ID, e.g. global.openai.gpt-5.5 or qwen.qwen3-32b-v1:0. */
  modelId: string;
  region?: string;
  awsProfile?: string;
  /** Output tokens per model call, reasoning included. Default 16000, the same as the Claude adapter. */
  maxTokens?: number;
  maxToolRounds?: number;
  /** Inject a client (tests); otherwise one is built from @aws-sdk/client-bedrock-runtime. */
  client?: ConverseClient;
}

async function loadSdk() {
  return importOptional("@aws-sdk/client-bedrock-runtime", () => import("@aws-sdk/client-bedrock-runtime"), "--agent bedrock:<model-id>");
}

async function makeClient(opts: BedrockConverseOptions): Promise<{ client: ConverseClient; command: (input: unknown) => unknown }> {
  if (opts.client) return { client: opts.client, command: (input) => input };
  const sdk = await loadSdk();
  const region = opts.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  let credentials: unknown;
  if (opts.awsProfile) {
    const { fromNodeProviderChain } = await importOptional("@aws-sdk/credential-providers", () => import("@aws-sdk/credential-providers"), "--aws-profile");
    credentials = fromNodeProviderChain({ profile: opts.awsProfile });
  }
  // Throttling is common when several trials run in parallel: give the SDK's retry strategy room.
  const client = new sdk.BedrockRuntimeClient({ maxAttempts: 8, ...(region ? { region } : {}), ...(credentials ? { credentials } : {}) } as never);
  return {
    client: client as unknown as ConverseClient,
    command: (input) => new sdk.ConverseCommand(input as never),
  };
}

/** The reply's text blocks as returned; reasoningContent blocks are never among them. */
const rawTextOf = (content: ConverseBlock[]) => content.map((b) => b.text ?? "").join("");

/**
 * What the reply says out loud: its text without reasoning. gpt-oss on Bedrock usually sends its reasoning in
 * reasoningContent blocks, but now and then inside the text, as <reasoning>…</reasoning> or <analysis>…</analysis>,
 * sometimes with no closing tag. The caller must never hear it: stripReasoning removes it.
 */
const textOf = (content: ConverseBlock[]) => stripReasoning(rawTextOf(content));

/** The result for a tool call that was not run, because the reply that made it ended some other way than with a call. */
const notRun = (toolUseId: string, stopReason: string | undefined): ConverseBlock => ({
  toolResult: { toolUseId, content: [{ text: JSON.stringify({ error: `not run: the reply ended with stop reason "${stopReason}"` }) }], status: "error" },
});

const FILTERED = "[agent output was filtered]";

/** Stop reasons a tool call is run under. Grok 4.7 sometimes ends a turn with a call under end_turn. */
const RUNS_TOOLS = new Set(["tool_use", "end_turn"]);

/** A reply stopped by a guardrail or content filter. */
const filteredStop = (res: ConverseResponse) => res.stopReason === "guardrail_intervened" || res.stopReason === "content_filtered";

/** A reply whose reasoning was never closed: the reasoning and the answer can't be told apart. */
const unclosedReasoning = (res: ConverseResponse) => {
  const content = res.output?.message?.content ?? [];
  return !content.some((b) => b.toolUse) && hasUnclosedReasoning(rawTextOf(content));
};

/** A reply with no tool call whose text is nothing but reasoning: once it is removed, the caller would hear silence. */
const silentAfterStrip = (res: ConverseResponse) => {
  const content = res.output?.message?.content ?? [];
  return !filteredStop(res) && !content.some((b) => b.toolUse) && onlyReasoning(rawTextOf(content));
};

/**
 * Where a model accepts Converse cache points. Every other model rejects the whole request when one
 * is present, so they get none; some of them (OpenAI GPT, Grok) cache on their own, which shows up in
 * the usage either way. Converse reads tools before the system prompt, so a point after the system
 * prompt also caches the tools.
 * - Claude: after the system prompt and on the newest message. Claude looks up to 20 blocks back for
 *   the previous turn's entry, so one moving point reads the conversation so far.
 * - Nova: after the system prompt and on the newest message that holds only text. Nova rejects one
 *   in the tool list or next to a toolUse or toolResult block.
 * A model is recognised by its ID, so an application inference profile ARN gets no cache points.
 */
type CacheStyle = { onlyText: boolean };

// Claude models from before Bedrock prompt caching: they take tools but reject cache points.
const UNCACHED_CLAUDE = /anthropic\.claude-(?:v2|instant|3-(?:haiku|sonnet|opus)|3-5-sonnet-20240620)/;

export function cacheStyle(modelId: string): CacheStyle | undefined {
  if (/(?:^|[./])anthropic\.claude-/.test(modelId) && !UNCACHED_CLAUDE.test(modelId)) return { onlyText: false };
  if (/(?:^|[./])amazon\.nova-/.test(modelId)) return { onlyText: true };
  return undefined;
}

const CACHE_POINT: ConverseBlock = { cachePoint: { type: "default" } };

/** The conversation with a cache point on the newest message that may hold one; the stored conversation is not changed. */
function withCachePoint(messages: ConverseMessage[], style: CacheStyle): ConverseMessage[] {
  const at = messages.findLastIndex((m) => !style.onlyText || m.content.every((b) => b.text !== undefined));
  return at < 0 ? messages : messages.map((m, i) => (i === at ? { ...m, content: [...m.content, CACHE_POINT] } : m));
}

/**
 * Agent adapter for any tool-capable model on Amazon Bedrock through the Converse API
 * (OpenAI GPT and gpt-oss, Grok, Kimi, GLM, Qwen, Mistral, Nova, ...).
 */
export function bedrockConverseAgent(opts: BedrockConverseOptions): AgentAdapter {
  const maxRounds = opts.maxToolRounds ?? 12;
  return {
    name: `bedrock:${opts.modelId}`,
    async createSession(ctx) {
      const { client, command } = await makeClient(opts);
      const cache = cacheStyle(opts.modelId);
      const toolConfig = ctx.tools.length
        ? { tools: ctx.tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.input_schema } } })) }
        : undefined;
      const system: ConverseBlock[] = cache ? [{ text: ctx.system }, CACHE_POINT] : [{ text: ctx.system }];
      // Append-only conversation in Converse's block format.
      const messages: ConverseMessage[] = [];
      // Converse rejects two user messages in a row: one that follows a user message not yet sent joins it.
      const pushUser = (content: ConverseBlock[]) => {
        const last = messages.at(-1);
        if (last?.role === "user") last.content.push(...content);
        else messages.push({ role: "user", content });
      };

      return {
        async reply(userMessage, callTool) {
          pushUser([{ text: userMessage || "(silence)" }]);
          /** One request; `attempt` counts the tries for this reply, so the last one can count a silent reply. */
          const request = async (attempt: number) => {
            const res = await client.send(
              command({
                modelId: opts.modelId,
                system,
                messages: cache ? withCachePoint(messages, cache) : messages,
                ...(toolConfig ? { toolConfig } : {}),
                inferenceConfig: { maxTokens: opts.maxTokens ?? 16000 },
              }),
            );
            const u = res.usage;
            const cut = res.stopReason === "max_tokens";
            const reasoning = hasReasoning(rawTextOf(res.output?.message?.content ?? []));
            // Still nothing but reasoning on the last try: the caller hears silence.
            const empty = attempt >= REASONING_RETRIES && silentAfterStrip(res);
            if (u || cut || reasoning) {
              ctx.recordUsage?.(opts.modelId, {
                input: u?.inputTokens ?? 0,
                output: u?.outputTokens ?? 0,
                cacheRead: u?.cacheReadInputTokens ?? 0,
                cacheWrite: u?.cacheWriteInputTokens ?? 0,
                // The reply hit maxTokens: what the agent says next may be cut off or empty.
                ...(cut ? { maxTokensStops: 1 } : {}),
                // Reasoning in the text, removed before the caller hears it.
                ...(reasoning ? { reasoningStripped: 1 } : {}),
                ...(empty ? { emptyAfterStrip: 1 } : {}),
              });
            }
            return res;
          };
          for (let round = 0; round < maxRounds; round++) {
            let res = await request(0);
            // Ask again before taking a reply whose reasoning never closed, or that is nothing but reasoning; neither
            // is added to the conversation.
            for (let retry = 1; retry <= REASONING_RETRIES && (unclosedReasoning(res) || silentAfterStrip(res)); retry++) res = await request(retry);
            const message = res.output?.message ?? { role: "assistant" as const, content: [] };
            const filtered = filteredStop(res);
            // Converse rejects an empty message, so an empty reply is kept as what the caller heard.
            const content = message.content.length > 0 ? message.content : [{ text: filtered ? FILTERED : "(silence)" }];
            messages.push({ role: "assistant", content });
            const text = textOf(message.content).trim();
            const uses = message.content.filter((b) => b.toolUse).map((b) => b.toolUse!);
            const run = uses.length > 0 && RUNS_TOOLS.has(res.stopReason ?? "");
            // A call in a reply that ended any other way (cut off, filtered, malformed) is not run, but it still gets
            // a result, or the next request fails.
            if (uses.length > 0 && !run) pushUser(uses.map((use) => notRun(use.toolUseId, res.stopReason)));
            if (filtered) return FILTERED;
            if (!run) return text;

            const results: ConverseBlock[] = [];
            for (const use of uses) {
              const out = await callTool(use.name, use.input);
              results.push({
                toolResult: {
                  toolUseId: use.toolUseId,
                  content: [{ text: JSON.stringify(out.ok ? out.result : { error: out.error }) }],
                  status: out.ok ? "success" : "error",
                },
              });
            }
            pushUser(results);
          }
          return "[agent exceeded its tool-call budget for this turn]";
        },
      };
    },
  };
}
