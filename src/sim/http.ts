import type { AgentAdapter } from "./types.ts";

/**
 * Rehearse any agent that speaks this small HTTP protocol (one POST per step):
 *
 *   request:  { session_id, system, tools, message? , tool_results? }
 *   response: { reply: string }                       // done with this turn
 *          or { tool_calls: [{ id, name, arguments }] } // sandtable executes them and POSTs tool_results back
 *
 * The agent keeps its own conversation state keyed by session_id. Tool calls run against
 * sandtable's simulated world, so nothing touches the customer's real systems.
 */
export function httpAgent(url: string, opts: { headers?: Record<string, string>; maxSteps?: number } = {}): AgentAdapter {
  const maxSteps = opts.maxSteps ?? 16;
  return {
    name: url,
    async createSession(ctx) {
      const post = async (body: Record<string, unknown>): Promise<HttpAgentResponse> => {
        let res: Response;
        try {
          res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", ...opts.headers },
            body: JSON.stringify({ session_id: ctx.sessionId, system: ctx.system, tools: ctx.tools, ...body }),
          });
        } catch (err) {
          // fetch says only "fetch failed"; the reason (ECONNREFUSED, ENOTFOUND, ...) is in err.cause.
          const cause = (err as { cause?: { code?: string; message?: string } }).cause;
          const reason = cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
          throw new Error(`could not reach the agent at ${url} (${reason}): is it running and listening there?`);
        }
        const text = await res.text();
        if (!res.ok) throw new Error(`agent endpoint ${url} returned ${res.status}: ${text}`);
        try {
          return JSON.parse(text) as HttpAgentResponse;
        } catch {
          throw new Error(`agent endpoint ${url} did not answer with JSON: ${text.slice(0, 200)}`);
        }
      };

      return {
        async reply(userMessage, callTool) {
          let response = await post({ message: userMessage });
          for (let step = 0; step < maxSteps; step++) {
            if (typeof response.reply === "string") return response.reply;
            const calls = response.tool_calls ?? [];
            if (calls.length === 0) throw new Error("agent response had neither reply nor tool_calls");
            const tool_results = [];
            for (const call of calls) {
              const out = await callTool(call.name, call.arguments);
              tool_results.push({ id: call.id, ok: out.ok, result: out.result, error: out.error });
            }
            response = await post({ tool_results });
          }
          return "[agent exceeded its step budget for this turn]";
        },
      };
    },
  };
}

interface HttpAgentResponse {
  reply?: string;
  tool_calls?: { id: string; name: string; arguments: unknown }[];
}
