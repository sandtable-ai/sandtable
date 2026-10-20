/**
 * Rehearse an agent built with the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`).
 *
 *   npx sandtable-ai run examples/freight --agent examples/frameworks/claude-agent-sdk/agent.ts
 *
 * sandtable calls the default export with no options and opens one session per trial.
 * Each session is one long-lived query() in streaming input mode: the SDK keeps the
 * conversation, and every user turn ends with a `result` message. The domain's tools are
 * served by an in-process MCP server whose handlers go through sandtable's `callTool`.
 * Claude Code's built-in tools (Bash, files, web, subagents) are turned off, so the only
 * tools the agent has are the simulated world's.
 *
 * Model: ANTHROPIC_MODEL, default claude-opus-5-5. Key: ANTHROPIC_API_KEY.
 */
import { createSdkMcpServer, query, tool, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentAdapter, CallTool, ToolSchema } from "sandtable-ai";
import { z } from "zod";

export interface Options {
  model?: string;
  /** Tool-use round trips per user turn. */
  maxTurns?: number;
}

/** The MCP server name: Claude sees each tool as mcp__sandtable__<tool>. */
const SERVER = "sandtable";

/**
 * The domain's tools on an in-process MCP server. Each handler calls `callTool`, which runs
 * the call against the simulated world. If your agent already has its own SDK MCP server,
 * keep its tool names and schemas (the domain's tools mirror them) and swap each handler's body.
 */
export function worldServer(schemas: ToolSchema[], callTool: CallTool) {
  return createSdkMcpServer({
    name: SERVER,
    // Keep every schema in the prompt instead of deferring it behind tool search.
    alwaysLoad: true,
    tools: schemas.map((t) =>
      tool(t.name, t.description, (z.fromJSONSchema(t.input_schema) as z.ZodObject).shape, async (args) => {
        const outcome = await callTool(t.name, args);
        return outcome.ok
          ? { content: [{ type: "text", text: JSON.stringify(outcome.result ?? null) }] }
          : { content: [{ type: "text", text: outcome.error ?? "error" }], isError: true };
      }),
    ),
  });
}

export default function claudeAgentSdkAgent(options: Options = {}): AgentAdapter {
  const model = options.model ?? process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5";
  return {
    name: "claude-agent-sdk",
    async createSession({ system, tools, recordUsage }) {
      // sandtable hands each turn its callTool; the server's handlers use the current one.
      let turnCallTool: CallTool | undefined;
      const server = worldServer(tools, (name, args) => turnCallTool!(name, args));
      const userTurns = inbox();
      const conversation = query({
        prompt: userTurns,
        options: {
          model,
          // Your agent's own system prompt goes here; this is sandtable's default (domain description and policy).
          systemPrompt: system,
          tools: [], // no built-in tools
          mcpServers: { [SERVER]: server },
          allowedTools: [`mcp__${SERVER}__*`],
          permissionMode: "dontAsk", // anything not allowed above is denied, never prompted
          settingSources: [], // ignore ~/.claude and project settings, CLAUDE.md and hooks
          strictMcpConfig: true, // ignore other MCP servers configured on this machine
          persistSession: false, // keep transcripts off disk
          maxTurns: options.maxTurns ?? 12,
        },
      });
      return {
        async reply(userMessage, callTool) {
          turnCallTool = callTool;
          userTurns.push({ type: "user", message: { role: "user", content: userMessage }, parent_tool_use_id: null });
          // Pull messages until this turn's result. Don't use for-await here: breaking out of it would end the query.
          for (;;) {
            const next = await conversation.next();
            if (next.done) throw new Error("the Claude Agent SDK session ended before replying");
            const message = next.value;
            if (message.type !== "result") continue;
            // Optional: report tokens so the run shows usage and cost. `usage` covers this turn's main loop.
            recordUsage?.(model, {
              input: message.usage.input_tokens,
              output: message.usage.output_tokens,
              cacheRead: message.usage.cache_read_input_tokens,
              cacheWrite: message.usage.cache_creation_input_tokens,
            });
            return message.subtype === "success" ? message.result : `[agent stopped: ${message.subtype}]`;
          }
        },
        async close() {
          userTurns.end();
          conversation.close();
        },
      };
    },
  };
}

/** An input stream for streaming input mode: an async iterable that stays open until `end()`. */
function inbox() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  return {
    push(message: SDKUserMessage) {
      queue.push(message);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
      for (;;) {
        const message = queue.shift();
        if (message) yield message;
        else if (ended) return;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
}
