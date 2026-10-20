/**
 * Rehearse an agent built with the Vercel AI SDK (`ai`).
 *
 *   npx sandtable-ai run examples/freight --agent examples/frameworks/vercel-ai-sdk/agent.ts
 *
 * sandtable calls the default export with no options and opens one session per trial.
 * The agent is a ToolLoopAgent: the AI SDK runs the tool loop, and every tool's `execute`
 * goes through sandtable's `callTool`, so it runs against the simulated world and is graded.
 *
 * Model: ANTHROPIC_MODEL, default claude-opus-5-5. Key: ANTHROPIC_API_KEY.
 */
import { anthropic } from "@ai-sdk/anthropic";
import { dynamicTool, isStepCount, jsonSchema, ToolLoopAgent, type JSONSchema7, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import type { AgentAdapter, CallTool, ToolSchema } from "sandtable-ai";

export interface Options {
  /** Any AI SDK model. The offline check passes a mock model here. */
  model?: LanguageModel;
  /** Model calls per user turn. */
  maxSteps?: number;
}

/**
 * Your agent, built the way you build it in production.
 *
 * - `instructions`: sandtable's default prompt (the domain description and policy). Pass your own instead.
 * - `tools`: built from the domain's JSON schemas. If your agent defines its own tools, keep their
 *   names and input schemas (the domain's tools mirror them) and swap each `execute` for `callTool`.
 */
function buildAgent(model: LanguageModel, instructions: string, tools: ToolSet, maxSteps: number) {
  return new ToolLoopAgent({ model, instructions, tools, stopWhen: isStepCount(maxSteps) });
}

/** The domain's tools as AI SDK tools whose `execute` runs in the simulated world. */
function worldTools(schemas: ToolSchema[], callTool: CallTool): ToolSet {
  return Object.fromEntries(
    schemas.map((t) => [
      t.name,
      dynamicTool({
        description: t.description,
        inputSchema: jsonSchema(t.input_schema as JSONSchema7),
        execute: async (input) => {
          const outcome = await callTool(t.name, input);
          // A thrown error goes back to the model as a tool error it can correct.
          if (!outcome.ok) throw new Error(outcome.error);
          return outcome.result;
        },
      }),
    ]),
  );
}

export default function vercelAiSdkAgent(options: Options = {}): AgentAdapter {
  const model = options.model ?? anthropic(process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5");
  const maxSteps = options.maxSteps ?? 12;
  return {
    name: "vercel-ai-sdk",
    async createSession({ system, tools, recordUsage }) {
      // One history per trial: the user turns plus every assistant and tool message the agent produced.
      const history: ModelMessage[] = [];
      return {
        async reply(userMessage, callTool) {
          history.push({ role: "user", content: userMessage });
          const agent = buildAgent(model, system, worldTools(tools, callTool), maxSteps);
          const result = await agent.generate({
            messages: history,
            // Optional: report tokens so the run shows usage and cost.
            onStepFinish: (step) =>
              recordUsage?.(step.model.modelId, {
                input: step.usage.inputTokenDetails.noCacheTokens ?? step.usage.inputTokens ?? 0,
                output: step.usage.outputTokens ?? 0,
                cacheRead: step.usage.inputTokenDetails.cacheReadTokens ?? 0,
                cacheWrite: step.usage.inputTokenDetails.cacheWriteTokens ?? 0,
              }),
          });
          history.push(...result.responseMessages);
          return result.text;
        },
      };
    },
  };
}
