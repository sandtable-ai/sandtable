import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serveConversations } from "../src/serve/driven.ts";
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

async function start(domain: Domain, t?: Task) {
  const graded: TrialResult[] = [];
  const served = await serveConversations(domain, { port: 0, label: "test agent", ...(t ? { task: t } : {}), onGraded: (trial) => graded.push(trial) });
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
    // The call is over: its id opens a new conversation.
    await post(`${url}/webhook`, vapiCall("call-a", "get_load", { load_id: "L-1001" }));
    expect((await json(`${url}/sessions`)).body).toHaveLength(1);
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
    const s = (await post(`${url}/sessions`, { task: "refuse" })).body;
    expect(s).toMatchObject({ id: expect.stringMatching(/^t\d+$/), task: "refuse", url: `${url}/s/${s.id}`, mcp: `${url}/s/${s.id}/mcp` });
    await post(`${s.url}/bookings`, BOOK);
    expect(await post(`${url}/sessions/${s.id}/end`, { transcript: [{ role: "agent", text: "Booked." }] })).toMatchObject({ status: 200, body: { passed: false, failed: [{ id: "verify-before-book" }, { id: "state:bookings#1" }] } });
    expect((await post(`${url}/sessions/${s.id}/end`, {})).status).toBe(404);
    expect((await post(`${url}/sessions/t99/end`, {})).status).toBe(404);
    const bad = (await post(`${url}/sessions`, { task: "book" })).body;
    expect(await post(`${url}/sessions/${bad.id}/end`, { transcript: [{ role: "robot", text: "hi" }] })).toMatchObject({ status: 400, body: { error: "transcript[0] needs a role (user or agent) and a text" } });
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

  it("refuses an ambiguous URL when several conversations are open", async () => {
    const domain = await domainWith(task());
    const { url } = await start(domain, domain.tasks[0]);
    await post(`${url}/sessions`, {});
    await post(`${url}/sessions`, {});
    expect(await post(`${url}/tools/get_load`, { load_id: "L-1001" })).toMatchObject({ status: 409, body: { error: /2 conversations are open at once/ } });
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
    await post(`${url}/webhook`, vapiCall("c1", "verify_carrier", { mc_number: "100101" }));
    await post(`${url}/webhook`, vapiCall("c1", "search_loads", { origin: "Dallas", destination: "Atlanta", equipment: "dry_van" }));
    await post(`${url}/webhook`, vapiCall("c1", "book_load", BOOK));
    await post(`${url}/webhook`, vapiEnd("c1", [{ role: "assistant", message: "Booked." }]));
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
});
