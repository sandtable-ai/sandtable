import Anthropic from "@anthropic-ai/sdk";
import type { UsageRecorder } from "../run/usage.ts";
import { STOP_TOKEN, USER_KICKOFF, userSystemPrompt } from "./prompts.ts";
import type { AgentAdapter, UserSimulator } from "./types.ts";

export const DEFAULT_MODEL = "claude-opus-5-5";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Where Claude runs: the Anthropic API, or Amazon Bedrock (AWS credentials from the usual chain). */
export type Provider = "anthropic" | "bedrock";

/** The part of the SDK client sandtable uses; both the Anthropic and Bedrock clients satisfy it. */
export type ClaudeClient = { beta: Pick<Anthropic["beta"], "messages"> };

export interface ClaudeOptions {
  model?: string;
  effort?: Effort;
  client?: ClaudeClient;
  /** Default: SANDTABLE_PROVIDER, else "anthropic". */
  provider?: Provider;
  /** Bedrock region. Default: AWS_REGION. */
  region?: string;
  /** AWS profile for Bedrock. Default: AWS_PROFILE / the default credential chain. */
  awsProfile?: string;
  /**
   * Opt into server-side refusal fallbacks (on by default where the model supports them).
   * Turn off to measure one model strictly: a fallback means another model served that turn.
   */
  fallbacks?: boolean;
}

export interface ClaudeAgentOptions extends ClaudeOptions {
  /** Max model calls per user turn before the agent is cut off. */
  maxToolRounds?: number;
}

const FALLBACK_MODELS = /^claude-(opus-5|fable-5|sonnet-5-5)/;

export function providerOf(opts: ClaudeOptions): Provider {
  const p = opts.provider ?? process.env.SANDTABLE_PROVIDER ?? "anthropic";
  if (p !== "anthropic" && p !== "bedrock") throw new Error(`unknown provider "${p}" (use anthropic or bedrock)`);
  return p;
}

/** Bedrock's Messages API takes `anthropic.`-prefixed IDs; inference profile IDs and ARNs pass through. */
export function resolveModel(model: string, provider: Provider): string {
  if (provider !== "bedrock" || model.includes(".") || model.startsWith("arn:")) return model;
  return `anthropic.${model}`;
}

/** Build the SDK client for the chosen provider. The Bedrock client is an optional dependency. */
export async function createClient(opts: ClaudeOptions): Promise<ClaudeClient> {
  if (opts.client) return opts.client;
  if (providerOf(opts) !== "bedrock") return new Anthropic();
  let mod: typeof import("@anthropic-ai/bedrock-sdk");
  try {
    mod = await import("@anthropic-ai/bedrock-sdk");
  } catch {
    throw new Error("--provider bedrock needs the optional package: npm install @anthropic-ai/bedrock-sdk");
  }
  return new mod.AnthropicBedrockMantle({
    awsRegion: opts.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
    ...(opts.awsProfile ? { awsProfile: opts.awsProfile } : {}),
  }) as unknown as ClaudeClient;
}

export function requestBase(opts: ClaudeOptions, defaultEffort: Effort) {
  const provider = providerOf(opts);
  const model = resolveModel(opts.model ?? DEFAULT_MODEL, provider);
  // Server-side refusal fallbacks exist on the Anthropic API only.
  const fallbacks = provider === "anthropic" && (opts.fallbacks ?? true) && FALLBACK_MODELS.test(model);
  return {
    model,
    max_tokens: 16000,
    output_config: { effort: opts.effort ?? defaultEffort },
    // System prompt, tools and history form a stable, append-only prefix: cache it automatically.
    cache_control: { type: "ephemeral" as const },
    ...(fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
  };
}

function report(ctx: { recordUsage?: UsageRecorder }, fallbackModel: string, response: Anthropic.Beta.BetaMessage) {
  const u = response.usage;
  if (!u) return;
  ctx.recordUsage?.(response.model ?? fallbackModel, {
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  });
}

function textOf(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** Reference agent: Claude with the domain's tools and policy. Use it as a baseline, or swap in your own agent. */
export function claudeAgent(opts: ClaudeAgentOptions = {}): AgentAdapter {
  const base = requestBase(opts, "medium");
  const maxRounds = opts.maxToolRounds ?? 12;
  return {
    name: `${providerOf(opts) === "bedrock" ? "bedrock" : "claude"}:${base.model}`,
    async createSession(ctx) {
      const client = await createClient(opts);
      const tools: Anthropic.Beta.BetaTool[] = ctx.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }));
      // Append-only history: full assistant content (including thinking blocks) goes back unchanged.
      const messages: Anthropic.Beta.BetaMessageParam[] = [];

      return {
        async reply(userMessage, callTool) {
          messages.push({ role: "user", content: userMessage });
          for (let round = 0; round < maxRounds; round++) {
            const response = await client.beta.messages.create({ ...base, system: ctx.system, tools, messages });
            report(ctx, base.model, response);
            messages.push({ role: "assistant", content: response.content });

            if (response.stop_reason === "refusal") return "[agent refused]";
            if (response.stop_reason === "pause_turn") continue;

            const toolUses = response.content.filter(
              (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
            );
            if (toolUses.length === 0 || response.stop_reason === "max_tokens") return textOf(response.content);

            const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
            for (const use of toolUses) {
              const out = await callTool(use.name, use.input);
              results.push({
                type: "tool_result",
                tool_use_id: use.id,
                content: JSON.stringify(out.ok ? out.result : { error: out.error }),
                ...(out.ok ? {} : { is_error: true }),
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

/** Simulated user played by Claude, with a persona and a hidden goal (tau-bench style). */
export function claudeUser(opts: ClaudeOptions = {}): UserSimulator {
  const base = requestBase(opts, "low");
  return {
    name: `${providerOf(opts) === "bedrock" ? "bedrock" : "claude"}:${base.model}`,
    async createSession(ctx) {
      const client = await createClient(opts);
      const system = userSystemPrompt(ctx.domain, ctx.task, ctx.persona);
      // From the simulator's point of view the agent is the "user" and it is the "assistant".
      const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: USER_KICKOFF }];
      let opened = false;

      return {
        async next(agentMessage) {
          if (!opened && ctx.task.user.opening) {
            opened = true;
            messages.push({ role: "assistant", content: ctx.task.user.opening });
            return { text: ctx.task.user.opening, stop: false };
          }
          opened = true;
          if (agentMessage !== null) messages.push({ role: "user", content: agentMessage || "(silence)" });
          const response = await client.beta.messages.create({ ...base, system, messages });
          report(ctx, base.model, response);
          messages.push({ role: "assistant", content: response.content });
          if (response.stop_reason === "refusal") return { text: "", stop: true };
          const raw = textOf(response.content);
          const stop = raw.includes(STOP_TOKEN);
          return { text: raw.replaceAll(STOP_TOKEN, "").trim(), stop };
        },
      };
    },
  };
}
