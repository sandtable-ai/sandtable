import type { TokenUsage, UsageRecorder } from "../run/usage.ts";
import type { ToolSchema } from "../world/tools.ts";
import { STOP_TOKEN, USER_KICKOFF, userSystemPrompt } from "./prompts.ts";
import type { AgentAdapter, CallTool, UserSimulator } from "./types.ts";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * Any endpoint that speaks OpenAI's Chat Completions API: OpenAI, OpenRouter, LiteLLM, vLLM,
 * Ollama, Groq, Together and others. Plain fetch, no SDK.
 */
export interface OpenAICompatOptions {
  /** Base URL up to the API version, e.g. https://api.openai.com/v1 or http://localhost:11434/v1. */
  baseUrl: string;
  /** Model name as the endpoint knows it (gpt-4.1-mini, meta-llama/llama-3.3-70b-instruct, llama3.1:8b). */
  model: string;
  /** Sent as a bearer token. Leave it out for local servers that need none. */
  apiKey?: string;
  /** Extra headers, e.g. OpenRouter's HTTP-Referer and X-Title. */
  headers?: Record<string, string>;
  /** Left out unless set: some models accept only their default. */
  temperature?: number;
  /** Retries on 429, 5xx and network errors, with backoff (default 4). */
  maxRetries?: number;
}

export interface OpenAICompatAgentOptions extends OpenAICompatOptions {
  /** Max model calls per user turn before the agent is cut off. */
  maxToolRounds?: number;
}

interface ToolCall {
  id?: string;
  type?: string;
  function: { name: string; arguments?: unknown };
  /** Provider fields (such as Gemini's thought signatures) go back unchanged. */
  [extra: string]: unknown;
}

interface AssistantMessage {
  role: "assistant";
  content?: string | Array<{ type?: string; text?: string }> | null;
  tool_calls?: ToolCall[];
  refusal?: string | null;
  [extra: string]: unknown;
}

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | AssistantMessage
  | { role: "tool"; tool_call_id: string; content: string };

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  /** DeepSeek reports cache hits here instead of prompt_tokens_details. */
  prompt_cache_hit_tokens?: number;
}

interface ChatCompletion {
  choices?: Array<{ message?: AssistantMessage; finish_reason?: string | null }>;
  usage?: ChatUsage;
}

interface FunctionTool {
  type: "function";
  function: { name: string; description: string; parameters: ToolSchema["input_schema"] };
}

/**
 * Map OpenAI usage to sandtable's: `prompt_tokens` includes cached tokens, while sandtable's `input`
 * excludes cache reads (the Anthropic convention), so cached tokens move to `cacheRead` and are priced once.
 */
export function usageOf(u: ChatUsage | undefined): Partial<Omit<TokenUsage, "calls">> {
  const cacheRead = u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens ?? 0;
  return { input: Math.max(0, (u?.prompt_tokens ?? 0) - cacheRead), output: u?.completion_tokens ?? 0, cacheRead };
}

function chatCompletions(opts: OpenAICompatOptions, recordUsage?: UsageRecorder) {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
  const headers = {
    "content-type": "application/json",
    ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
    ...opts.headers,
  };

  const maxRetries = opts.maxRetries ?? 4;
  return async (messages: ChatMessage[], tools: FunctionTool[] = []) => {
    const body = JSON.stringify({
      model: opts.model,
      messages,
      // Servers reject an empty tools array.
      ...(tools.length ? { tools } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    });
    let res: Response | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(url, { method: "POST", headers, body });
      } catch (err) {
        // Network failure: retry like a 5xx.
        if (attempt >= maxRetries) throw err;
        await sleep(backoffMs(attempt));
        continue;
      }
      // Rate limits and server errors are the host's problem, not the agent's: retry with backoff.
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        await sleep(backoffMs(attempt, res.headers.get("retry-after")));
        continue;
      }
      break;
    }
    if (!res.ok) throw new Error(`${url} returned ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const data = (await res.json()) as ChatCompletion;
    const choice = data.choices?.[0];
    // Keyed by the requested name, not the served snapshot, so the price lookup is stable.
    // Recorded even without a usage block, so an unpriced model shows cost n/a rather than $0.
    // finish_reason "length": the reply hit the server's token limit and may be cut off.
    recordUsage?.(opts.model, { ...usageOf(data.usage), ...(choice?.finish_reason === "length" ? { maxTokensStops: 1 } : {}) });
    if (!choice?.message) throw new Error(`${url} returned no choices`);
    return { message: choice.message, finishReason: choice.finish_reason ?? null };
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with jitter, honouring Retry-After (seconds) when the host sends one. */
export function backoffMs(attempt: number, retryAfter?: string | null): number {
  const hinted = retryAfter ? Number(retryAfter) * 1000 : Number.NaN;
  if (Number.isFinite(hinted) && hinted >= 0) return Math.min(hinted, 60_000);
  return Math.min(500 * 2 ** attempt, 20_000) * (0.75 + Math.random() * 0.5);
}

function textOf(content: AssistantMessage["content"]): string {
  const text = typeof content === "string" ? content : (content ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
  // Reasoning models served without a reasoning parser (Qwen, DeepSeek) inline their thinking; the caller never hears it.
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/** Tool calls with the ids and type a follow-up request needs, filled in where a server left them out. */
function toolCallsOf(message: AssistantMessage, salt: number): Array<ToolCall & { id: string }> {
  return (message.tool_calls ?? []).map((c, i) => ({ ...c, id: c.id || `call_${salt}_${i}`, type: c.type ?? "function" }));
}

/** The assistant message as returned (reasoning and provider fields included), minus an empty tool_calls array. */
function historyEntry(message: AssistantMessage, calls: ToolCall[]): AssistantMessage {
  const { tool_calls: _calls, ...rest } = message;
  return { ...rest, role: "assistant", content: message.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) };
}

const toolMessage = (id: string, value: unknown): ChatMessage => ({ role: "tool", tool_call_id: id, content: JSON.stringify(value ?? null) });

function parseArguments(raw: unknown): { ok: true; args: unknown } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: true, args: raw ?? {} }; // a few servers send an object
  if (raw.trim() === "") return { ok: true, args: {} };
  try {
    return { ok: true, args: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function runToolCall(call: ToolCall & { id: string }, callTool: CallTool): Promise<ChatMessage> {
  const parsed = parseArguments(call.function.arguments);
  // Unparseable arguments still reach the world (as the raw string, which it rejects), so the
  // attempt shows in the trajectory and counts as an attempt; the model gets the parse error.
  const out = await callTool(call.function.name, parsed.ok ? parsed.args : call.function.arguments);
  if (!parsed.ok) return toolMessage(call.id, { error: `arguments are not valid JSON (${parsed.error}); call the tool again with a JSON object` });
  return toolMessage(call.id, out.ok ? out.result : { error: out.error });
}

/** An agent served behind an OpenAI-compatible endpoint, with the domain's tools and policy. */
export function openaiCompatAgent(opts: OpenAICompatAgentOptions): AgentAdapter {
  const maxRounds = opts.maxToolRounds ?? 12;
  return {
    name: `openai:${opts.model}`,
    async createSession(ctx) {
      const complete = chatCompletions(opts, ctx.recordUsage);
      const tools: FunctionTool[] = ctx.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
      // Append-only history: earlier messages are never rewritten, so prefix caching can hit.
      const messages: ChatMessage[] = [{ role: "system", content: ctx.system }];

      return {
        async reply(userMessage, callTool) {
          messages.push({ role: "user", content: userMessage });
          for (let round = 0; round < maxRounds; round++) {
            const { message, finishReason } = await complete(messages, tools);
            const calls = toolCallsOf(message, messages.length);
            messages.push(historyEntry(message, calls));
            const text = textOf(message.content);

            if (finishReason === "length" || finishReason === "content_filter") {
              // A cut-off or filtered reply may hold partial tool calls. Answer them without running
              // anything, so the next request is still valid.
              for (const call of calls) messages.push(toolMessage(call.id, { error: `not executed: the reply ended with finish_reason "${finishReason}"` }));
              if (finishReason === "content_filter") return "[agent reply blocked by the provider's content filter]";
              return text || "[agent reply cut off at the output token limit]";
            }
            // Tool calls drive the loop, whatever the finish_reason: some servers report "stop" with them.
            if (calls.length === 0) return text || (message.refusal ? "[agent refused]" : "");
            for (const call of calls) messages.push(await runToolCall(call, callTool));
          }
          return "[agent exceeded its tool-call budget for this turn]";
        },
      };
    },
  };
}

/** Simulated user served behind an OpenAI-compatible endpoint, with a persona and a hidden goal. */
export function openaiCompatUser(opts: OpenAICompatOptions): UserSimulator {
  return {
    name: `openai:${opts.model}`,
    async createSession(ctx) {
      const complete = chatCompletions(opts, ctx.recordUsage);
      // From the simulator's point of view the agent is the "user" and it is the "assistant".
      const messages: ChatMessage[] = [
        { role: "system", content: userSystemPrompt(ctx.domain, ctx.task, ctx.persona) },
        { role: "user", content: USER_KICKOFF },
      ];
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
          const { message, finishReason } = await complete(messages);
          messages.push(historyEntry(message, []));
          const raw = textOf(message.content);
          if (finishReason === "content_filter" || (!raw && message.refusal)) return { text: "", stop: true };
          return { text: raw.replaceAll(STOP_TOKEN, "").trim(), stop: raw.includes(STOP_TOKEN) };
        },
      };
    },
  };
}
