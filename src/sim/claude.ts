import Anthropic from "@anthropic-ai/sdk";
import type { UsageRecorder } from "../run/usage.ts";
import { importOptional } from "./optional.ts";
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
  /** Bedrock client: "classic" (inference profiles, default) or "mantle". Default: SANDTABLE_BEDROCK_CLIENT. */
  bedrockClient?: "classic" | "mantle";
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

export type BedrockClientKind = "classic" | "mantle";

function bedrockKind(opts: ClaudeOptions): BedrockClientKind {
  const k = opts.bedrockClient ?? process.env.SANDTABLE_BEDROCK_CLIENT ?? "classic";
  if (k !== "classic" && k !== "mantle") throw new Error(`unknown Bedrock client "${k}" (use classic or mantle)`);
  return k;
}

function bedrockRegion(opts: ClaudeOptions): string | undefined {
  return opts.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
}

/** Cross-region inference profile prefix for a Bedrock region (eu-west-1 -> eu). */
export function inferenceGeo(region: string | undefined): string {
  if (!region) return "global";
  if (region.startsWith("eu-")) return "eu";
  if (region.startsWith("us-") || region.startsWith("ca-")) return "us";
  if (region.startsWith("ap-")) return "apac";
  return "global";
}

/**
 * Map a plain model name to what the provider expects. On Bedrock, the classic client takes
 * cross-region inference profiles (eu.anthropic.claude-opus-5-5); the Mantle client takes
 * anthropic.-prefixed IDs. Full IDs and ARNs pass through unchanged.
 */
export function resolveModel(model: string, provider: Provider, opts: Pick<ClaudeOptions, "region" | "bedrockClient"> = {}): string {
  if (provider !== "bedrock" || model.includes(".") || model.startsWith("arn:")) return model;
  if (bedrockKind(opts) === "mantle") return `anthropic.${model}`;
  return `${inferenceGeo(bedrockRegion(opts))}.anthropic.${model}`;
}

/** Build the SDK client for the chosen provider. The Bedrock client is an optional dependency. */
export async function createClient(opts: ClaudeOptions): Promise<ClaudeClient> {
  if (opts.client) return opts.client;
  // More retries than the SDK default: long multi-trial runs hit rate limits.
  if (providerOf(opts) !== "bedrock") return withHints(new Anthropic({ maxRetries: 5 }), "anthropic");
  const mod = await importOptional("@anthropic-ai/bedrock-sdk", () => import("@anthropic-ai/bedrock-sdk"), "--provider bedrock");
  const awsRegion = bedrockRegion(opts);
  if (bedrockKind(opts) === "mantle") {
    return withHints(new mod.AnthropicBedrockMantle({ awsRegion, maxRetries: 5, ...(opts.awsProfile ? { awsProfile: opts.awsProfile } : {}) }) as unknown as ClaudeClient, "bedrock");
  }
  const profile = opts.awsProfile;
  return withHints(
    new mod.AnthropicBedrock({
      maxRetries: 5,
      ...(awsRegion ? { awsRegion } : {}),
      ...(profile
        ? {
            providerChainResolver: async () => {
              const { fromNodeProviderChain } = await importOptional(
                "@aws-sdk/credential-providers",
                () => import("@aws-sdk/credential-providers"),
                "--aws-profile",
              );
              return fromNodeProviderChain({ profile });
            },
          }
        : {}),
    }) as unknown as ClaudeClient,
    "bedrock",
  );
}

/**
 * Rewrite the SDK's credential errors into what to do about them. Without a key, the Anthropic SDK
 * says "Could not resolve authentication method. Expected one of apiKey, authToken, ...".
 */
export function explainClaudeError(err: unknown, provider: Provider): unknown {
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number } | undefined)?.status;
  if (provider === "anthropic") {
    if (message.includes("Could not resolve authentication method")) {
      return new Error(
        "no Anthropic credentials: set ANTHROPIC_API_KEY (or sign in with `ant auth login`), or pass --provider bedrock to run Claude on Amazon Bedrock with your AWS credentials",
      );
    }
    if (status === 401) return new Error(`the Anthropic API rejected the credentials (401): check ANTHROPIC_API_KEY. ${message}`);
    return err;
  }
  if (/Failed to resolve AWS credentials|Could not load credentials/i.test(message)) {
    return new Error(
      `no AWS credentials for --provider bedrock: pass --aws-profile or set AWS_PROFILE, or configure the default AWS credential chain. ${message}`,
    );
  }
  return err;
}

/** Wrap the client's `beta.messages` calls so credential errors say what to do. */
export function withHints(client: ClaudeClient, provider: Provider): ClaudeClient {
  const messages = new Proxy(client.beta.messages, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        try {
          const out = (value as (...a: unknown[]) => unknown).apply(target, args);
          return out instanceof Promise
            ? out.catch((err: unknown) => {
                throw explainClaudeError(err, provider);
              })
            : out;
        } catch (err) {
          throw explainClaudeError(err, provider);
        }
      };
    },
  });
  return { beta: { messages } } as ClaudeClient;
}

export function requestBase(opts: ClaudeOptions, defaultEffort: Effort) {
  const provider = providerOf(opts);
  const model = resolveModel(opts.model ?? DEFAULT_MODEL, provider, opts);
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
