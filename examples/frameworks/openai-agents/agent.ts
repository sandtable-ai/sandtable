/**
 * Rehearse an agent built with the OpenAI Agents SDK (`@openai/agents`).
 *
 *   npx sandtable-ai run examples/freight --agent examples/frameworks/openai-agents/agent.ts
 *
 * sandtable calls the default export with no options and opens one session per trial.
 * The SDK's Runner runs the tool loop, and every function tool's `execute` goes through
 * sandtable's `callTool`, so it runs against the simulated world and is graded.
 *
 * Model: OPENAI_MODEL, else the SDK's default model. Key: OPENAI_API_KEY.
 */
import { Agent, Runner, getDefaultModel, tool, type AgentInputItem, type Model, type Tool } from "@openai/agents";
import type { AgentAdapter, CallTool, ToolSchema } from "sandtable-ai";

export interface Options {
  /** A model name, or any Model. The offline check passes a scripted model here. */
  model?: string | Model;
  /** Model calls per user turn. Past it, the Runner throws and the trial fails as a runtime error. */
  maxTurns?: number;
}

/**
 * Your agent, built the way you build it in production.
 *
 * - `instructions`: sandtable's default prompt (the domain description and policy). Pass your own instead.
 * - `tools`: built from the domain's JSON schemas. If your agent defines its own function tools, keep
 *   their names and parameters (the domain's tools mirror them) and swap each `execute` for `callTool`.
 */
function buildAgent(model: string | Model, instructions: string, tools: Tool[]) {
  return new Agent({ name: "Agent under rehearsal", instructions, model, tools });
}

/** The domain's tools as function tools whose `execute` runs in the simulated world. */
function worldTools(schemas: ToolSchema[], callTool: CallTool): Tool[] {
  return schemas.map((t) =>
    tool({
      name: t.name,
      description: t.description,
      // Strict mode (the default) works as is: the SDK sends optional params as nullable
      // and drops the nulls before `execute`, so callTool sees only the arguments the model set.
      parameters: t.input_schema,
      execute: async (input) => {
        const outcome = await callTool(t.name, input);
        // Return the error as output: the SDK replaces a thrown error with a generic message,
        // and the model needs the real one ("Load L-1003 is not available") to correct itself.
        return outcome.ok ? outcome.result : { error: outcome.error };
      },
    }),
  );
}

export default function openaiAgentsAgent(options: Options = {}): AgentAdapter {
  const model = options.model ?? process.env.OPENAI_MODEL ?? getDefaultModel();
  const maxTurns = options.maxTurns ?? 12;
  return {
    name: "openai-agents",
    async createSession({ system, tools, sessionId, recordUsage }) {
      // groupId links the trial's turns as one conversation in the OpenAI traces dashboard.
      const runner = new Runner({ workflowName: "sandtable rehearsal", groupId: sessionId });
      // One history per trial: every input and output item so far.
      let history: AgentInputItem[] = [];
      return {
        async reply(userMessage, callTool) {
          const agent = buildAgent(model, system, worldTools(tools, callTool));
          const result = await runner.run(agent, [...history, { role: "user", content: userMessage }], { maxTurns });
          history = result.history;
          // Optional: report tokens so the run shows usage and cost.
          for (const { usage } of result.rawResponses) {
            const cached = usage.inputTokensDetails.reduce((n, d) => n + (d.cached_tokens ?? 0), 0);
            recordUsage?.(typeof model === "string" ? model : "custom-model", {
              input: usage.inputTokens - cached,
              output: usage.outputTokens,
              cacheRead: cached,
            });
          }
          return result.finalOutput ?? "";
        },
      };
    },
  };
}
