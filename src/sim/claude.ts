import Anthropic from "@anthropic-ai/sdk";
import type { UsageRecorder } from "../run/usage.ts";
import { STOP_TOKEN, USER_KICKOFF, userSystemPrompt } from "./prompts.ts";
import type { AgentAdapter, UserSimulator } from "./types.ts";

export const DEFAULT_MODEL = "claude-opus-5-5";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeOptions {
  model?: string;
  effort?: Effort;
  client?: Anthropic;
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

function requestBase(opts: ClaudeOptions, defaultEffort: Effort) {
  const model = opts.model ?? DEFAULT_MODEL;
  const fallbacks = (opts.fallbacks ?? true) && FALLBACK_MODELS.test(model);
  return {
    model,
    max_tokens: 16000,
    output_config: { effort: opts.effort ?? defaultEffort },
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
    name: `claude:${base.model}`,
    async createSession(ctx) {
      const client = opts.client ?? new Anthropic();
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
    name: `claude:${base.model}`,
    async createSession(ctx) {
      const client = opts.client ?? new Anthropic();
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
