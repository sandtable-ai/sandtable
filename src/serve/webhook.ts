import type { FaultApplied } from "../grade/invariants.ts";
import { isPlainObject } from "../world/match.ts";
import type { ToolOutcome } from "../world/tools.ts";

/** One tool call a webhook asked for: the platform's id for it, when it gives one. */
export interface WebhookCall {
  id?: string;
  name: string;
  args: unknown;
}

/** One line of a transcript a platform sends when a call ends, with when it was said (epoch ms) when the platform says. */
export interface TranscriptLine {
  role: "user" | "agent";
  text: string;
  time?: number;
}

/**
 * What a webhook request asks for, by the platform whose payload it is:
 * - `calls`: run tools. Vapi's `tool-calls` message, Retell's custom function (`{ name, args, call }`), or a generic
 *   `{ name | tool, arguments | args | parameters }`. At `/webhook/<tool>`, the body is that tool's arguments, alone or
 *   in Retell's wrapper.
 * - `end`: the call is over (Vapi's `end-of-call-report`, Retell's `call_ended` event), with what was said.
 * - `ignore`: another Vapi server message or Retell event, such as a status update, which needs no answer.
 * `callId` is the platform's id for the conversation, when the payload has one.
 */
export type WebhookRequest =
  | { kind: "calls"; platform: "vapi" | "retell" | "generic"; callId?: string; calls: WebhookCall[] }
  | { kind: "end"; platform: "vapi" | "retell"; callId?: string; transcript: TranscriptLine[] }
  | { kind: "ignore"; platform: "vapi" | "retell"; callId?: string }
  | { kind: "invalid"; error: string };

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

/** Arguments a platform may send as a JSON string: parsed when they are one, else as they are. */
function argsOf(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function parseWebhook(body: unknown, pathTool?: string): WebhookRequest {
  if (!isPlainObject(body)) return { kind: "invalid", error: "the body must be a JSON object" };
  if (pathTool !== undefined) {
    // Retell's wrapper names the function; with "payload: args only", the body is the arguments.
    const wrapped = str(body.name) === pathTool && isPlainObject(body.args);
    const callId = wrapped && isPlainObject(body.call) ? str(body.call.call_id) : undefined;
    return { kind: "calls", platform: wrapped ? "retell" : "generic", ...(callId ? { callId } : {}), calls: [{ name: pathTool, args: wrapped ? body.args : body }] };
  }
  const message = body.message;
  if (isPlainObject(message) && typeof message.type === "string") {
    const callId = isPlainObject(message.call) ? str(message.call.id) : undefined;
    const id = callId ? { callId } : {};
    if (message.type === "tool-calls") {
      const list = Array.isArray(message.toolCallList)
        ? message.toolCallList
        : Array.isArray(message.toolWithToolCallList)
          ? message.toolWithToolCallList.map((t) => (isPlainObject(t) ? t.toolCall : undefined))
          : [];
      const calls: WebhookCall[] = [];
      for (const c of list) {
        if (!isPlainObject(c)) continue;
        const fn = isPlainObject(c.function) ? c.function : {};
        const name = str(fn.name) ?? str(c.name);
        if (name) calls.push({ ...(str(c.id) ? { id: str(c.id) } : {}), name, args: argsOf(fn.arguments ?? c.arguments) });
      }
      if (calls.length === 0) return { kind: "invalid", error: "a Vapi tool-calls message with no tool call in toolCallList" };
      return { kind: "calls", platform: "vapi", ...id, calls };
    }
    if (message.type === "end-of-call-report") {
      const artifact = isPlainObject(message.artifact) ? message.artifact : {};
      const transcript: TranscriptLine[] = [];
      for (const m of Array.isArray(artifact.messages) ? artifact.messages : []) {
        const line = transcriptLine(m, m && (m as Record<string, unknown>).message);
        if (line) transcript.push(line);
      }
      return { kind: "end", platform: "vapi", ...id, transcript };
    }
    return { kind: "ignore", platform: "vapi", ...id };
  }
  // Retell's call events: call_ended carries the transcript; call_started and call_analyzed need nothing.
  if (typeof body.event === "string" && isPlainObject(body.call)) {
    const callId = str(body.call.call_id);
    const id = callId ? { callId } : {};
    if (body.event !== "call_ended") return { kind: "ignore", platform: "retell", ...id };
    const transcript: TranscriptLine[] = [];
    for (const m of Array.isArray(body.call.transcript_object) ? body.call.transcript_object : []) {
      const line = transcriptLine(m, m && (m as Record<string, unknown>).content);
      if (line) transcript.push(line);
    }
    return { kind: "end", platform: "retell", ...id, transcript };
  }
  const name = str(body.name) ?? str(body.tool);
  if (!name) {
    return {
      kind: "invalid",
      error: "unrecognized webhook payload: send Vapi's tool-calls message, Retell's { name, args }, { name, arguments }, or the arguments alone to /webhook/<tool>",
    };
  }
  const retell = isPlainObject(body.args) && isPlainObject(body.call);
  const callId = retell ? str((body.call as Record<string, unknown>).call_id) : undefined;
  return { kind: "calls", platform: retell ? "retell" : "generic", ...(callId ? { callId } : {}), calls: [{ name, args: argsOf(body.arguments ?? body.args ?? body.parameters) }] };
}

/** A platform's transcript entry as a line: a user's or the agent's words, and when, if it says; undefined for tool entries. */
function transcriptLine(m: unknown, text: unknown): TranscriptLine | undefined {
  if (!isPlainObject(m) || typeof text !== "string" || !text) return undefined;
  const role = m.role === "user" ? "user" : m.role === "assistant" || m.role === "bot" || m.role === "agent" ? "agent" : undefined;
  if (!role) return undefined;
  return { role, text, ...(typeof m.time === "number" && Number.isFinite(m.time) ? { time: m.time } : {}) };
}

/** A tool's answer to a webhook call. */
export interface WebhookResult {
  call: WebhookCall;
  outcome: ToolOutcome;
  fault?: FaultApplied;
}

/** A tool's result as text, as Vapi wants it: a string as it is, anything else as JSON. */
const asText = (v: unknown) => (typeof v === "string" ? v : (JSON.stringify(v) ?? "null"));

/**
 * The HTTP answer to a webhook's tool calls. A tool error is an answer, so it comes with status 200, as Vapi requires
 * and as Retell shows the body to its model: Vapi's `{ results: [{ toolCallId, result | error }] }`, else the result
 * itself or `{ error }`. A fault that hit a call answers the whole request with its status instead (504, 429 with
 * Retry-After, or a 5xx), as a real outage would: Vapi then tells its model that no result came back.
 */
export function webhookAnswer(platform: "vapi" | "retell" | "generic", results: WebhookResult[]): { status: number; body: unknown; headers?: Record<string, string> } {
  const faulted = results.find((r) => r.fault?.status !== undefined);
  if (faulted) {
    const { fault, outcome } = faulted;
    return { status: fault!.status!, body: { error: outcome.error }, ...(fault!.retryAfter !== undefined ? { headers: { "retry-after": String(fault!.retryAfter) } } : {}) };
  }
  if (platform === "vapi") {
    return {
      status: 200,
      body: { results: results.map(({ call, outcome }) => ({ toolCallId: call.id ?? "", ...(outcome.ok ? { result: asText(outcome.result) } : { error: outcome.error ?? "error" }) })) },
    };
  }
  const { outcome } = results[0]!;
  return { status: 200, body: outcome.ok ? (outcome.result ?? null) : { error: outcome.error } };
}
