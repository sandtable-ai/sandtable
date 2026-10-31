import type { Domain } from "../spec/schema.ts";
import { version } from "../version.ts";
import { isPlainObject } from "../world/match.ts";
import { toolSchema, type ToolOutcome } from "../world/tools.ts";

/**
 * The domain's tools as an MCP server, over Streamable HTTP with plain JSON responses (no SSE stream): `initialize`,
 * `ping`, `tools/list` and `tools/call`. Each JSON-RPC message gets one response; a notification gets none.
 */

/** The MCP protocol versions this server answers to, newest first. A client asking for another gets the newest. */
export const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

type JsonRpcId = string | number | null;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Runs a tool for `tools/call`, in the trial the request belongs to, or says why there is none. */
export type McpCall = (name: string, args: unknown) => Promise<ToolOutcome | { noTrial: string }>;

const error = (id: JsonRpcId, code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

/** The response to one JSON-RPC message, or undefined for a notification or a response, which need none. */
export async function mcpMessage(domain: Domain, message: unknown, call: McpCall): Promise<JsonRpcResponse | undefined> {
  if (!isPlainObject(message) || message.jsonrpc !== "2.0") return error(null, -32600, "Invalid Request: expected a JSON-RPC 2.0 message");
  if (typeof message.method !== "string") return undefined;
  if (!("id" in message)) return undefined;
  const id = message.id as JsonRpcId;
  const params = isPlainObject(message.params) ? message.params : {};
  switch (message.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: asked && MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "sandtable", version },
          instructions: `The simulated world of ${domain.name}, served by sandtable for a rehearsal: every call is checked against the domain's rules and changes only simulated records.`,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: domain.tools.map((t) => {
            const s = toolSchema(t);
            return { name: s.name, description: s.description, inputSchema: s.input_schema };
          }),
        },
      };
    case "tools/call": {
      if (typeof params.name !== "string") return error(id, -32602, "Invalid params: tools/call needs a tool name");
      const out = await call(params.name, params.arguments ?? {});
      if ("noTrial" in out) return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: out.noTrial }], isError: true } };
      const text = out.ok ? (JSON.stringify(out.result) ?? "null") : (out.error ?? "error");
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: !out.ok } };
    }
    default:
      return error(id, -32601, `Method not found: ${message.method}`);
  }
}

/** The response to a POST's body: one message or a batch. Undefined when nothing needs an answer (HTTP 202). */
export async function mcpBody(domain: Domain, body: unknown, call: McpCall): Promise<unknown> {
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => mcpMessage(domain, m, call)))).filter((r) => r !== undefined);
    return out.length ? out : undefined;
  }
  return mcpMessage(domain, body, call);
}
