import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_IDLE_TIMEOUT, serveConversations, type DrivenOptions } from "../src/serve/driven.ts";
import type { SuiteResult } from "../src/run/suite.ts";
import type { TrialResult } from "../src/run/episode.ts";
import { loadDomain } from "../src/spec/load.ts";
import { TaskSpec, type Domain, type Task } from "../src/spec/schema.ts";

// sandtable serve (#444): conversations another system drives, such as a hosted voice platform's test calls, each
// graded when it ends. Every request goes to a server on 127.0.0.1.

const example = path.resolve("examples/freight");
const cli = path.resolve("src/cli.ts");
const BOOK = { load_id: "L-1001", mc_number: "100101", rate: 2100 };

/** A task as YAML would give it. */
function task(extra: Partial<Omit<Task, "expect">> & { expect?: Record<string, unknown> } = {}): Task {
  return TaskSpec.parse({
    id: "book",
    user: { instructions: "You are Dana, MC 100101. You want L-1001." },
    expect: { state: [{ table: "bookings", where: { load_id: "L-1001", mc_number: "100101" }, count: 1 }], called: ["verify_carrier"] },
    ...extra,
  });
}

async function domainWith(...tasks: Task[]): Promise<Domain> {
  return { ...(await loadDomain(example)), tasks };
}

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((s) => s()));
});

async function start(domain: Domain, t?: Task, extra: Partial<DrivenOptions> = {}) {
  const graded: TrialResult[] = [];
  const served = await serveConversations(domain, { port: 0, label: "test agent", ...(t ? { task: t } : {}), ...extra, onGraded: (trial) => {
      graded.push(trial);
    } });
  stops.push(() => served.server.stop());
  return { ...served, graded, url: served.server.url };
}

async function json(url: string, init: RequestInit = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...init.headers } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
}
const post = (url: string, body: unknown, headers: Record<string, string> = {}) => json(url, { method: "POST", body: JSON.stringify(body), headers });

/** Vapi's tool-calls message for one call. */
const vapiCall = (callId: string, name: string, args: unknown, id = "tc") => ({ message: { type: "tool-calls", call: { id: callId }, toolCallList: [{ id, type: "function", function: { name, arguments: args } }] } });
const vapiEnd = (callId: string, messages: unknown[]) => ({ message: { type: "end-of-call-report", endedReason: "hangup", call: { id: callId }, artifact: { messages } } });

describe("sandtable serve: conversations a platform drives", () => {
  it("opens a session per Vapi call id, and grades it at the end-of-call report with its transcript", async () => {
    const domain = await domainWith(task({ expect: { state: [{ table: "bookings", where: BOOK, count: 1 }], called: ["verify_carrier"], reply_includes: ["booked"] } }));
    const { url, graded, result } = await start(domain, domain.tasks[0]);
    // Two calls at once, each with its own world.
    for (const call of ["call-a", "call-b"]) {
      expect((await post(`${url}/webhook`, vapiCall(call, "verify_carrier", { mc_number: "100101" }))).body.results[0].result).toContain("Blue Mesa");
    }
    expect((await post(`${url}/webhook`, vapiCall("call-a", "book_load", BOOK))).body.results[0]).toMatchObject({ toolCallId: "tc", result: expect.stringContaining("confirmed") });
    // call-b books the same load in its own world, so it is still available there.
    expect((await post(`${url}/webhook`, vapiCall("call-b", "book_load", BOOK))).body.results[0].result).toContain("confirmed");
    const endA = await post(`${url}/webhook`, vapiEnd("call-a", [{ role: "user", message: "MC 100101, I want L-1001." }, { role: "assistant", message: "Done: L-1001 is booked." }]));
    expect(endA).toMatchObject({ status: 200, body: { task: "book", trial: 0, passed: true, failed: [] } });
    const endB = await post(`${url}/webhook`, vapiEnd("call-b", [{ role: "bot", message: "Sorry, I can't." }]));
    expect(endB.body).toMatchObject({ passed: false, failed: [{ id: "reply:booked" }] });
    expect(graded.map((t) => [t.trial, t.passed])).toEqual([[0, true], [1, false]]);
    const a = graded[0]!;
    // The tool calls go before the agent's first line, after what the caller said.
    expect(a.events.map((e) => (e.type === "tool" ? `${e.name} via ${e.via}` : e.type))).toEqual(["user", "verify_carrier via webhook", "book_load via webhook", "agent"]);
    expect(a.endReason).toBe("user_stop");
    expect(a.changes.map((c) => `${c.kind} ${c.table}`)).toEqual(expect.arrayContaining(["insert bookings", "update loads"]));
    const r = result()!;
    expect(r).toMatchObject({ agent: "test agent", user: "external", k: 2, tasks: [{ id: "book", passes: 1, graded: 2 }], latency: { agentTurnP50Ms: null, agentTurnP95Ms: null } });
    // The call is over: a platform's retry of its webhooks opens no new conversation, and its end isn't graded twice.
    expect(await post(`${url}/webhook`, vapiCall("call-a", "get_load", { load_id: "L-1001" }))).toMatchObject({ status: 409, body: { error: "call call-a has ended, and its conversation was graded" } });
    expect(await post(`${url}/webhook`, vapiEnd("call-a", []))).toMatchObject({ status: 200, body: { ignored: "call call-a has ended, and its conversation was graded" } });
    expect((await json(`${url}/sessions`)).body).toHaveLength(0);
    expect(graded).toHaveLength(2);
  });

  it("grades a call with no tool call when it ends, and orders lines and calls by time when every line has one", async () => {
    const domain = await domainWith(task({ id: "refuse", expect: { state: [{ table: "bookings", count: 0 }] } }));
    const { url, graded } = await start(domain, domain.tasks[0]);
    expect((await post(`${url}/webhook`, vapiEnd("quiet", [{ role: "assistant", message: "Hi." }]))).body).toMatchObject({ passed: true });
    const before = Date.now();
    await post(`${url}/webhook`, vapiCall("timed", "get_load", { load_id: "L-1001" }));
    await post(`${url}/webhook`, vapiEnd("timed", [{ role: "assistant", message: "Hello.", time: before - 1000 }, { role: "user", message: "L-1001?", time: before - 500 }, { role: "assistant", message: "It pays $2100.", time: Date.now() + 1000 }]));
    expect(graded[1]!.events.map((e) => e.type)).toEqual(["agent", "user", "tool", "agent"]);
  });

  it("opens a session per Retell call id and grades it at call_ended, with transcript_object", async () => {
    const domain = await domainWith(task());
    const { url, graded } = await start(domain, domain.tasks[0]);
    const retell = (name: string, args: unknown) => ({ name, args, call: { call_id: "r-1", call_status: "ongoing" } });
    expect((await post(`${url}/webhook`, retell("verify_carrier", { mc_number: "100101" }))).body).toMatchObject({ name: "Blue Mesa Trucking" });
    await post(`${url}/webhook`, retell("book_load", BOOK));
    expect((await post(`${url}/webhook`, { event: "call_started", call: { call_id: "r-1" } })).body).toEqual({});
    const end = await post(`${url}/webhook`, { event: "call_ended", call: { call_id: "r-1", transcript_object: [{ role: "agent", content: "Booked L-1001." }, { role: "user", content: "Thanks." }] } });
    expect(end.body).toMatchObject({ passed: true });
    expect(graded[0]!.events.map((e) => e.type)).toEqual(["tool", "tool", "agent", "user"]);
  });

  it("treats an MCP connection as a conversation: initialize opens it, Mcp-Session-Id names it, DELETE grades it", async () => {
    const domain = await domainWith(task());
    const { url, graded } = await start(domain, domain.tasks[0]);
    const init = await post(`${url}/mcp`, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    const id = init.headers.get("mcp-session-id")!;
    expect(id).toMatch(/^t\d+$/);
    const other = (await post(`${url}/mcp`, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).headers.get("mcp-session-id")!;
    expect(other).not.toBe(id);
    const call = (sid: string, name: string, args: unknown) => post(`${url}/mcp`, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, { "mcp-session-id": sid });
    await call(id, "verify_carrier", { mc_number: "100101" });
    await call(id, "book_load", BOOK);
    expect((await call(other, "book_load", BOOK)).body.result.isError).toBe(false);
    const del = await json(`${url}/mcp`, { method: "DELETE", headers: { "mcp-session-id": id } });
    expect(del.body).toMatchObject({ session: id, passed: true });
    expect(graded[0]!.events.map((e) => e.type === "tool" && `${e.name} via ${e.via}`)).toEqual(["verify_carrier via mcp", "book_load via mcp"]);
    // An ended session's id is gone: the client must initialize again.
    expect((await call(id, "get_load", { load_id: "L-1001" })).status).toBe(404);
    // The other connection didn't verify the carrier.
    expect((await json(`${url}/mcp`, { method: "DELETE", headers: { "mcp-session-id": other } })).body).toMatchObject({ passed: false, failed: [{ id: "verify-before-book" }, { id: "called:verify_carrier" }] });
  });

  it("opens sessions with POST /sessions for any task, and grades them at POST /sessions/<id>/end", async () => {
    const domain = await domainWith(task(), task({ id: "refuse", expect: { state: [{ table: "bookings", count: 0 }] } }));
    const { url, graded, result } = await start(domain);
    // No default task: a request that names no session can't open one.
    expect(await post(`${url}/tools/get_load`, { load_id: "L-1001" })).toMatchObject({ status: 409, body: { error: /no task to rehearse: start sandtable serve with --task/ } });
    expect(await post(`${url}/sessions`, { task: "nope" })).toMatchObject({ status: 404, body: { error: 'unknown task "nope" in freight-carrier-sales' } });
    for (const body of [[], { task: 5 }, "refuse"]) expect(await post(`${url}/sessions`, body)).toMatchObject({ status: 400, body: { error: 'POST /sessions takes no body, or { "task": "<id>" }' } });
    const s = (await post(`${url}/sessions`, { task: "refuse" })).body;
    expect(s).toMatchObject({ id: expect.stringMatching(/^t\d+$/), task: "refuse", url: `${url}/s/${s.id}`, mcp: `${url}/s/${s.id}/mcp` });
    await post(`${s.url}/bookings`, BOOK);
    expect(await post(`${url}/sessions/${s.id}/end`, { transcript: [{ role: "agent", text: "Booked." }] })).toMatchObject({ status: 200, body: { passed: false, failed: [{ id: "verify-before-book" }, { id: "state:bookings#1" }] } });
    expect((await post(`${url}/sessions/${s.id}/end`, {})).status).toBe(404);
    expect((await post(`${url}/sessions/t99/end`, {})).status).toBe(404);
    const bad = (await post(`${url}/sessions`, { task: "book" })).body;
    expect(await post(`${url}/sessions/${bad.id}/end`, { transcript: [{ role: "robot", text: "hi" }] })).toMatchObject({ status: 400, body: { error: "transcript[0] needs a role (user or agent) and a text" } });
    for (const time of ["9:00", -1]) expect(await post(`${url}/sessions/${bad.id}/end`, { transcript: [{ role: "agent", text: "hi", time }] })).toMatchObject({ status: 400, body: { error: "transcript[0].time must be a time in milliseconds since the epoch" } });
    expect(result()!.tasks.map((t) => t.id)).toEqual(["refuse"]);
    expect(graded).toHaveLength(1);
  });

  it("skips a conversation that ended without a transcript when its task checks what the agent said, unless the agent broke a rule", async () => {
    const t = task({ expect: { state: [], called: ["verify_carrier"], reply_includes: ["booked"] } });
    const domain = await domainWith(t);
    const { url } = await start(domain, t);
    // A session the first request opens, with no call id: the default task.
    await post(`${url}/tools/verify_carrier`, { mc_number: "100101" });
    const [s] = (await json(`${url}/sessions`)).body;
    expect((await post(`${url}/sessions/${s.id}/end`, {})).body).toMatchObject({ passed: false, skipped: true });
    await post(`${url}/bookings`, BOOK);
    const [s2] = (await json(`${url}/sessions`)).body;
    // Booking without verifying breaks verify-before-book: failed, not skipped.
    const end = (await post(`${url}/sessions/${s2.id}/end`, {})).body;
    expect(end.skipped).toBeUndefined();
    expect(end.failed.map((f: { id: string }) => f.id)).toContain("verify-before-book");
  });

  it("never sends a request that names no session to a conversation a call id or an MCP connection names", async () => {
    const domain = await domainWith(task());
    const { url } = await start(domain, domain.tasks[0]);
    // An MCP client that never sends DELETE leaves its conversation open.
    const init = await post(`${url}/mcp`, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const mcp = init.headers.get("mcp-session-id")!;
    await post(`${url}/webhook`, vapiCall("v-1", "get_load", { load_id: "L-1001" }));
    await post(`${url}/tools/book_load`, BOOK);
    const open = (await json(`${url}/sessions`)).body as { id: string }[];
    expect(open).toHaveLength(3);
    const rest = open.find((s) => s.id !== mcp && s.id !== "t2")!;
    // The booking went to a conversation of its own: the MCP one is untouched.
    const mcpCalls = await post(`${url}/mcp`, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_load", arguments: { load_id: "L-1001" } } }, { "mcp-session-id": mcp });
    expect(JSON.parse(mcpCalls.body.result.content[0].text).status).toBe("available");
    expect((await post(`${url}/tools/get_load`, { load_id: "L-1001" })).body.status).toBe("booked");
    expect(rest).toBeDefined();
  });

  it("grades an ElevenLabs call at its post-call webhook: webhook tools on http routes with no call id, then post_call_transcription (#459)", async () => {
    const domain = await domainWith(task());
    const { url, graded } = await start(domain, domain.tasks[0]);
    const start_time_unix_secs = Math.floor(Date.now() / 1000) - 1;
    // ElevenLabs calls each webhook tool's own URL: a GET with a path param, and a form-encoded POST.
    expect((await json(`${url}/carriers/100101`)).body).toMatchObject({ name: "Blue Mesa Trucking" });
    const form = await fetch(`${url}/bookings`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "load_id=L-1001&mc_number=100101&rate=2100" });
    expect(await form.json()).toMatchObject({ load_id: "L-1001", status: "confirmed" });
    expect((await post(`${url}/webhook`, { type: "post_call_audio", event_timestamp: 1, data: { conversation_id: "conv-1", full_audio: "" } })).body).toEqual({});
    const webhookCall = (tool_name: string) => ({ request_id: tool_name, tool_name, params_as_json: "{}", tool_has_been_called: true, type: "webhook" });
    const end = {
      type: "post_call_transcription",
      event_timestamp: start_time_unix_secs + 60,
      data: {
        agent_id: "agent-1",
        conversation_id: "conv-1",
        status: "done",
        transcript: [
          { role: "user", message: "MC 100101, I want L-1001.", time_in_call_secs: 0, tool_calls: null },
          { role: "agent", message: null, time_in_call_secs: 1, tool_calls: [webhookCall("verify_carrier"), { ...webhookCall("end_call"), type: "system" }] },
          { role: "agent", message: null, time_in_call_secs: 2, tool_calls: [webhookCall("book_load"), { ...webhookCall("get_load"), tool_has_been_called: false }] },
          { role: "agent", message: "L-1001 is booked.", time_in_call_secs: 3600, tool_calls: null },
        ],
        metadata: { start_time_unix_secs, call_duration_secs: 60 },
      },
    };
    expect((await post(`${url}/webhook`, end)).body).toMatchObject({ task: "book", trial: 0, passed: true, failed: [] });
    // A large form is read in one pass: 80,000 fields in about 700 KB answer at once.
    const many = Array.from({ length: 80_000 }, (_, i) => `f${i}=1`).join("&");
    const big = await fetch(`${url}/s/${(await post(`${url}/sessions`, {})).body.id}/bookings`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: many });
    expect(big.status).toBe(400);
    // Lines and calls in order of time: the agent's reply came after the calls, an hour into the call.
    expect(graded[0]!.events.map((e) => (e.type === "tool" ? `${e.name} via ${e.via}` : e.type))).toEqual(["user", "verify_carrier via rest", "book_load via rest", "agent"]);
    // ElevenLabs retries a webhook that failed: a second end of the same call isn't graded again.
    expect((await post(`${url}/webhook`, end)).body).toEqual({ ignored: "call conv-1 has ended, and its conversation was graded" });
    expect(graded).toHaveLength(1);
    // A failed call initiation needs no answer.
    expect((await post(`${url}/webhook`, { type: "call_initiation_failure", event_timestamp: 1, data: { conversation_id: "conv-2", failure_reason: "busy" } })).body).toEqual({});
  });

  it("keeps ElevenLabs calls at the same time apart with an X-Sandtable-Call header, and skips calls it can't tell apart without one (#459)", async () => {
    const domain = await domainWith(task());
    const transcription = (conversation_id: string, tools: string[]) => ({
      type: "post_call_transcription",
      event_timestamp: 1,
      data: {
        conversation_id,
        transcript: [
          { role: "agent", message: null, tool_calls: tools.map((tool_name) => ({ tool_name, params_as_json: "{}", tool_has_been_called: true, type: "webhook" })) },
          { role: "agent", message: "L-1001 is booked.", tool_calls: null },
        ],
      },
    });
    {
      const { url, graded } = await start(domain, domain.tasks[0]);
      // Interleaved, each with its own world: both book the same load.
      for (const call of ["conv-a", "conv-b"]) expect((await json(`${url}/carriers/100101`, { headers: { "x-sandtable-call": call } })).status).toBe(200);
      for (const call of ["conv-a", "conv-b"]) expect((await post(`${url}/bookings`, BOOK, { "x-sandtable-call": call })).body).toMatchObject({ status: "confirmed" });
      expect((await post(`${url}/webhook`, transcription("conv-b", ["verify_carrier", "book_load"]))).body).toMatchObject({ passed: true });
      expect((await post(`${url}/webhook`, transcription("conv-a", ["verify_carrier", "book_load"]))).body).toMatchObject({ passed: true });
      expect(graded.map((t) => t.events.filter((e) => e.type === "tool").length)).toEqual([2, 2]);
    }
    {
      const { url, graded } = await start(domain, domain.tasks[0]);
      // Without the header, the second call's request goes to the first call's world, as any request that names no
      // conversation goes to the one open: the transcripts show it, and neither call is graded on that world.
      await json(`${url}/carriers/100101`);
      await json(`${url}/carriers/100101`);
      await post(`${url}/bookings`, BOOK);
      const a = await post(`${url}/webhook`, transcription("conv-a", ["verify_carrier", "book_load"]));
      expect(a.body).toMatchObject({ passed: false, skipped: true });
      expect(graded[0]!.error).toMatch(/^call conv-a's transcript lists its tool calls as verify_carrier, book_load, but the conversation it was matched to got verify_carrier, verify_carrier, book_load, so this call isn't graded on it: with no call id on its tool requests, another call's requests can go to the same world/);
      expect(graded[0]!.error).toContain("X-Sandtable-Call header (on ElevenLabs, {{system__conversation_id}})");
      expect((await post(`${url}/webhook`, transcription("conv-b", ["verify_carrier"]))).body).toMatchObject({ passed: false, skipped: true });
      expect(graded[1]!.error).toMatch(/lists its tool calls as verify_carrier, but the conversation it was matched to got none/);
    }
    {
      const { url, graded } = await start(domain, domain.tasks[0]);
      // A post-call webhook with no transcript entries says nothing about the call's tool calls, so it isn't checked.
      await json(`${url}/carriers/100101`);
      await post(`${url}/bookings`, BOOK);
      expect((await post(`${url}/webhook`, { type: "post_call_transcription", event_timestamp: 1, data: { conversation_id: "conv-d", transcript: [] } })).body).toMatchObject({ passed: true });
      expect(graded[0]!.error).toBeUndefined();
    }
    {
      const { url } = await start(domain, domain.tasks[0]);
      // Two conversations no call names: an end can't tell which is its own.
      await post(`${url}/sessions`, {});
      await post(`${url}/sessions`, {});
      expect(await post(`${url}/webhook`, transcription("conv-c", []))).toMatchObject({ status: 409, body: { error: /2 conversations are open that no call names/ } });
    }
  });

  it("refuses an ambiguous URL when several conversations are open", async () => {
    const domain = await domainWith(task());
    const { url } = await start(domain, domain.tasks[0]);
    await post(`${url}/sessions`, {});
    await post(`${url}/sessions`, {});
    expect(await post(`${url}/tools/get_load`, { load_id: "L-1001" })).toMatchObject({ status: 409, body: { error: /2 conversations are open at once/ } });
  });
});

describe("sandtable serve: a conversation whose end never comes (#467)", () => {
  const MIN = 60_000;
  const idleError = (n: number) =>
    `no request and no end of the conversation came within ${n} ${n === 1 ? "minute" : "minutes"}, so it was ended without one: check that the platform sends its end of call to this server (--idle-timeout ${n})`;
  /** Only the timers the idle clock uses are fake, so the local server and fetch run as they do. */
  const fakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const openIds = async (url: string) => ((await json(`${url}/sessions`)).body as { id: string }[]).map((s) => s.id);
  const mcpInit = async (url: string) => (await post(`${url}/mcp`, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).headers.get("mcp-session-id")!;
  const mcpCall = (url: string, sid: string, name: string, args: unknown) => post(`${url}/mcp`, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, { "mcp-session-id": sid });

  it("ends one with no request for 30 minutes by default, and grades it as a trial that ended in that error: skipped, unless the agent broke a rule", async () => {
    fakeClock();
    const domain = await domainWith(task());
    const { url, graded, result } = await start(domain, domain.tasks[0]);
    // A Vapi call that verifies the carrier, and a session that books without verifying it, then goes quiet.
    await post(`${url}/webhook`, vapiCall("v-1", "verify_carrier", { mc_number: "100101" }));
    const quiet = (await post(`${url}/sessions`, {})).body;
    expect((await post(`${quiet.url}/bookings`, BOOK)).status).toBe(200);
    await vi.advanceTimersByTimeAsync(29 * MIN);
    await post(`${url}/webhook`, vapiCall("v-1", "book_load", BOOK));
    await vi.advanceTimersByTimeAsync(MIN - 1);
    expect(graded).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    // 30 minutes after its last request, the quiet one is ended and graded at once: failed, since it broke a rule.
    expect(graded).toHaveLength(1);
    expect(graded[0]).toMatchObject({ passed: false, endReason: "error", error: idleError(30) });
    expect(graded[0]!.skipped).toBeUndefined();
    expect(graded[0]!.checks.filter((c) => !c.passed).map((c) => c.id)).toContain("verify-before-book");
    expect(await openIds(url)).not.toContain(quiet.id);
    // The call's own clock restarted at its last request: it ends 30 minutes after that, skipped, since it broke none.
    await vi.advanceTimersByTimeAsync(29 * MIN - 1);
    expect(graded).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(graded[1]).toMatchObject({ passed: false, skipped: true, endReason: "error", error: idleError(30) });
    expect(graded[1]!.events.filter((e) => e.type === "tool").map((e) => e.type === "tool" && e.name)).toEqual(["verify_carrier", "book_load"]);
    expect(await openIds(url)).toEqual([]);
    expect(result()).toMatchObject({ k: 2, tasks: [{ id: "book" }] });
  });

  it("restarts a conversation's clock on each request routed to it, over REST, an http route, MCP or a webhook, and on no other's", async () => {
    fakeClock();
    const domain = await domainWith(task());
    const { url, graded } = await start(domain, domain.tasks[0], { idleTimeout: 10 });
    await post(`${url}/webhook`, vapiCall("v-1", "verify_carrier", { mc_number: "100101" }));
    const call = (await openIds(url))[0]!;
    const mcp = await mcpInit(url);
    await post(`${url}/tools/get_load`, { load_id: "L-1001" });
    const rest = (await openIds(url)).find((id) => id !== call && id !== mcp)!;
    await vi.advanceTimersByTimeAsync(4 * MIN);
    // A request that names no session goes to the one open conversation no call names: its clock restarts.
    await post(`${url}/tools/get_load`, { load_id: "L-1001" });
    await vi.advanceTimersByTimeAsync(2 * MIN);
    // A platform's status update for an open call is a request for it too.
    expect((await post(`${url}/webhook`, { message: { type: "status-update", status: "in-progress", call: { id: "v-1" } } })).body).toEqual({});
    await vi.advanceTimersByTimeAsync(2 * MIN);
    await mcpCall(url, mcp, "get_load", { load_id: "L-1001" });
    await vi.advanceTimersByTimeAsync(MIN);
    // The call's tool's http route at its own URL.
    expect((await json(`${url}/s/${call}/carriers/100101`)).status).toBe(200);
    await vi.advanceTimersByTimeAsync(5 * MIN - 1);
    expect(await openIds(url)).toEqual([call, mcp, rest]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await openIds(url)).toEqual([call, mcp]);
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(await openIds(url)).toEqual([call]);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(await openIds(url)).toEqual([]);
    expect(graded.map((t) => t.error)).toEqual([idleError(10), idleError(10), idleError(10)]);
  });

  it("stops serving its world, and answers its late end as already graded: a platform's end-of-call webhook, an MCP DELETE or POST /sessions/<id>/end", async () => {
    fakeClock();
    const domain = await domainWith(task());
    const { url, graded } = await start(domain, domain.tasks[0]);
    await post(`${url}/webhook`, vapiCall("v-1", "verify_carrier", { mc_number: "100101" }));
    const mcp = await mcpInit(url);
    const s = (await post(`${url}/sessions`, {})).body;
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(graded).toHaveLength(3);
    expect(await openIds(url)).toEqual([]);
    const ignored = (what: string) => ({ status: 200, body: { ignored: `${what} has ended, and its conversation was graded` } });
    expect(await post(`${url}/webhook`, vapiEnd("v-1", [{ role: "assistant", message: "Booked." }]))).toMatchObject(ignored("call v-1"));
    expect(await json(`${url}/mcp`, { method: "DELETE", headers: { "mcp-session-id": mcp } })).toMatchObject(ignored(`session ${mcp}`));
    expect(await post(`${url}/sessions/${s.id}/end`, { transcript: [{ role: "agent", text: "Booked." }] })).toMatchObject(ignored(`session ${s.id}`));
    expect(graded).toHaveLength(3);
    // A later request that names it is answered as for any conversation that ended.
    expect(await post(`${url}/webhook`, vapiCall("v-1", "book_load", BOOK))).toMatchObject({ status: 409, body: { error: "call v-1 has ended, and its conversation was graded" } });
    expect((await mcpCall(url, mcp, "get_load", { load_id: "L-1001" })).status).toBe(404);
    expect((await post(`${s.url}/tools/get_load`, { load_id: "L-1001" })).status).toBe(404);
    // A request that names no session no longer goes to it: it opens a conversation of its own.
    await post(`${url}/tools/get_load`, { load_id: "L-1001" });
    const now = await openIds(url);
    expect(now).toHaveLength(1);
    expect(now[0]).not.toBe(s.id);
  });

  it("never ends one with an idle timeout of 0, says 1 minute in the singular, and refuses a timeout that isn't a whole number of minutes", async () => {
    fakeClock();
    const domain = await domainWith(task());
    {
      const { url, graded } = await start(domain, domain.tasks[0], { idleTimeout: 0 });
      const s = (await post(`${url}/sessions`, {})).body;
      await vi.advanceTimersByTimeAsync(7 * 24 * 60 * MIN);
      expect(await openIds(url)).toEqual([s.id]);
      expect(graded).toHaveLength(0);
    }
    {
      const { url, graded } = await start(domain, domain.tasks[0], { idleTimeout: 1 });
      await post(`${url}/sessions`, {});
      await vi.advanceTimersByTimeAsync(MIN);
      expect(graded[0]!.error).toBe(idleError(1));
      expect(graded[0]!.error).toContain("within 1 minute, so");
    }
    for (const idleTimeout of [-1, 1.5, Number.NaN, Infinity, 40_000]) {
      await expect(serveConversations(domain, { port: 0, label: "test agent", idleTimeout })).rejects.toThrow(/idleTimeout must be a whole number of minutes/);
    }
  });

  it("clears its timers when the server stops, and they never keep the process alive", async () => {
    const set = vi.spyOn(globalThis, "setTimeout");
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const domain = await domainWith(task());
    const served = await serveConversations(domain, { port: 0, label: "test agent", task: domain.tasks[0]! });
    await post(`${served.server.url}/sessions`, {});
    const at = set.mock.calls.findIndex((c) => c[1] === 30 * MIN);
    expect(at).toBeGreaterThanOrEqual(0);
    const timer = set.mock.results[at]!.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    // Ctrl-C reports it as not graded.
    expect(served.openSessions()).toHaveLength(1);
    await served.server.stop();
    expect(clear).toHaveBeenCalledWith(timer);
  });
});

describe("the serve command", () => {
  /** A port no server listens on right now. */
  async function freePort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as { port: number };
    await new Promise((resolve) => probe.close(resolve));
    return port;
  }

  it.skipIf(!process.features.typescript)("serves until stopped, writes results after each graded conversation, and summarizes on Ctrl-C", { timeout: 30_000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-serve-cli-"));
    const port = await freePort();
    const child = spawn(process.execPath, [cli, "serve", example, "--task", "book-at-posted-rate", "--port", String(port), "-o", dir, "--label", "vapi-assistant"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stdout += d));
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100 && !stdout.includes("Results:"); i++) await new Promise((r) => setTimeout(r, 100));
    expect(stdout).toContain(`Serving freight-carrier-sales at ${url} for conversations another system drives`);
    expect(stdout).toContain("Each conversation is a trial of book-at-posted-rate");
    expect(stdout).toContain("One with no request for 30 minutes is ended without its end, and skipped unless the agent broke a rule (--idle-timeout).");
    await post(`${url}/webhook`, vapiCall("c1", "verify_carrier", { mc_number: "100101" }));
    await post(`${url}/webhook`, vapiCall("c1", "search_loads", { origin: "Dallas", destination: "Atlanta", equipment: "dry_van" }));
    await post(`${url}/webhook`, vapiCall("c1", "book_load", BOOK));
    await post(`${url}/webhook`, vapiEnd("c1", [{ role: "assistant", message: "Booked." }]));
    // The end is answered once results.json has the grade.
    expect(JSON.parse(await readFile(path.join(dir, "results.json"), "utf8")).tasks[0].passes).toBe(1);
    // An open conversation at shutdown is not graded.
    await post(`${url}/webhook`, vapiCall("c2", "get_load", { load_id: "L-1001" }));
    for (let i = 0; i < 50; i++) {
      const written = await readFile(path.join(dir, "results.json"), "utf8").catch(() => "");
      if (written.includes("book-at-posted-rate")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const written = JSON.parse(await readFile(path.join(dir, "results.json"), "utf8")) as SuiteResult;
    expect(written).toMatchObject({ agent: "vapi-assistant", user: "external", tasks: [{ id: "book-at-posted-rate", passes: 1 }] });
    const code = await new Promise<number | null>((resolve) => {
      child.on("exit", resolve);
      child.kill("SIGINT");
    });
    expect(code).toBe(0);
    expect(stdout).toContain("✓ book-at-posted-rate trial 1");
    expect(stdout).toMatch(/1 conversation\(s\) still open were not graded: t2/);
    expect(stdout).toContain("pass^1 100.0%");
    expect(stdout).toContain(`results: ${path.join(dir, "results.json")}`);
    expect((await readFile(path.join(dir, "report.html"), "utf8")).length).toBeGreaterThan(1000);
  });

  it.skipIf(!process.features.typescript)("refuses an --idle-timeout that isn't a whole number of minutes", { timeout: 30_000 }, async () => {
    const results = await Promise.all(
      ["-1", "abc", "1.5"].map((v) => promisify(execFile)(process.execPath, [cli, "serve", example, "--idle-timeout", v]).catch((err: { code: number; stderr: string }) => err)),
    );
    for (const r of results) expect(r).toMatchObject({ code: 2, stderr: expect.stringContaining(`must be a whole number of minutes, 0-${MAX_IDLE_TIMEOUT} (0 turns it off)`) });
  });
});
