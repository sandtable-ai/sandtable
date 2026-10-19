import { importOptional } from "./optional.ts";
import type { AgentAdapter } from "./types.ts";

/** The slice of BedrockRuntimeClient this adapter uses; injectable for tests. */
export interface ConverseClient {
  send(command: unknown): Promise<ConverseResponse>;
}

interface ConverseBlock {
  text?: string;
  toolUse?: { toolUseId: string; name: string; input: unknown };
  toolResult?: { toolUseId: string; content: { text: string }[]; status?: "success" | "error" };
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

/**
 * gpt-oss on Bedrock usually sends its reasoning in reasoningContent blocks, but now and then inside the
 * text as <reasoning>…</reasoning>, sometimes with no closing tag. The caller must never hear it.
 */
const REASONING = /<reasoning>[\s\S]*?<\/reasoning>/g;
const MALFORMED_RETRIES = 2;

const textOf = (content: ConverseBlock[]) =>
  content
    .map((b) => b.text ?? "")
    .join("")
    .replace(REASONING, "");

/** A reply whose reasoning was never closed: the reasoning and the answer can't be told apart. */
const unclosedReasoning = (res: ConverseResponse) => res.stopReason !== "tool_use" && textOf(res.output?.message?.content ?? []).includes("<reasoning>");

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
      const toolConfig = ctx.tools.length
        ? { tools: ctx.tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.input_schema } } })) }
        : undefined;
      // Append-only conversation in Converse's block format.
      const messages: ConverseMessage[] = [];

      return {
        async reply(userMessage, callTool) {
          messages.push({ role: "user", content: [{ text: userMessage || "(silence)" }] });
          const request = async () => {
            const res = await client.send(
              command({
                modelId: opts.modelId,
                system: [{ text: ctx.system }],
                messages,
                ...(toolConfig ? { toolConfig } : {}),
                inferenceConfig: { maxTokens: opts.maxTokens ?? 4096 },
              }),
            );
            const u = res.usage;
            if (u) {
              ctx.recordUsage?.(opts.modelId, {
                input: u.inputTokens ?? 0,
                output: u.outputTokens ?? 0,
                cacheRead: u.cacheReadInputTokens ?? 0,
                cacheWrite: u.cacheWriteInputTokens ?? 0,
              });
            }
            return res;
          };
          for (let round = 0; round < maxRounds; round++) {
            let res = await request();
            // Ask again before taking a reply whose reasoning never closed; it is never added to the conversation.
            for (let retry = 0; retry < MALFORMED_RETRIES && unclosedReasoning(res); retry++) res = await request();
            const message = res.output?.message ?? { role: "assistant" as const, content: [] };
            messages.push({ role: "assistant", content: message.content });
            const text = textOf(message.content).trim();
            if (res.stopReason === "guardrail_intervened" || res.stopReason === "content_filtered") return "[agent output was filtered]";
            const uses = message.content.filter((b) => b.toolUse).map((b) => b.toolUse!);
            if (res.stopReason !== "tool_use" || uses.length === 0) return text;

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
            messages.push({ role: "user", content: results });
          }
          return "[agent exceeded its tool-call budget for this turn]";
        },
      };
    },
  };
}
