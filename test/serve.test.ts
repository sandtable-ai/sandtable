import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runEpisode } from "../src/run/episode.ts";
import { taskFingerprints } from "../src/run/inputs.ts";
import { runSuite, type SuiteResult } from "../src/run/suite.ts";
import { createToolRunner } from "../src/run/tool-runner.ts";
import { startWorldServer, type WorldServer } from "../src/serve/server.ts";
import { MCP_VERSIONS } from "../src/serve/mcp.ts";
import { httpAgent } from "../src/sim/http.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import type { AgentAdapter, AgentContext, CallTool, WorldUrls } from "../src/sim/types.ts";
import { loadDomain, validateDomain } from "../src/spec/load.ts";
import { TaskSpec, type Domain, type Task } from "../src/spec/schema.ts";
import { worldFor } from "../src/world/store.ts";

// The world server (#443): each trial's simulated world over REST, MCP and webhooks, for an agent that calls its tools
// itself. Every request goes to a server on 127.0.0.1, so nothing leaves the machine.

const example = path.resolve("examples/freight");
const cli = path.resolve("src/cli.ts");
const user = { instructions: "You are Dana, MC 100101. You want L-1001.", script: ["MC 100101, I want L-1001.", "Yes, book it.", "Thanks, bye."] };
const BOOK = { load_id: "L-1001", mc_number: "100101", rate: 2100 };

/** A task as YAML would give it: TaskSpec fills in the defaults. */
function task(extra: Partial<Omit<Task, "expect">> & { expect?: Record<string, unknown> } = {}): Task {
  return TaskSpec.parse({ id: "book", user, expect: { state: [{ table: "bookings", where: { load_id: "L-1001" }, count: 1 }], called: ["verify_carrier", "book_load"] }, ...extra });
}

async function domainWith(...tasks: Task[]): Promise<Domain> {
  return { ...(await loadDomain(example)), tasks };
}

/** A port no server listens on right now. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const servers: WorldServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function serve(domain: Domain): Promise<WorldServer> {
  const s = await startWorldServer(domain, { port: 0 });
  servers.push(s);
  return s;
}

/** A trial's world served on its own, as runEpisode opens it. */
async function served(t: Task = task()) {
  const domain = await domainWith(t);
  const server = await serve(domain);
  const runner = createToolRunner(domain, worldFor(domain, t), undefined, t);
  return { domain, server, runner, session: server.open(t, runner) };
}

async function json(url: string, init: RequestInit = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...init.headers } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
}
const post = (url: string, body: unknown) => json(url, { method: "POST", body: JSON.stringify(body) });

/** An MCP JSON-RPC request, or a notification (no id). */
const rpc = (url: string, method: string, params: unknown = {}) => post(url, { jsonrpc: "2.0", id: 1, method, params });
const notify = (url: string, method: string) => post(url, { jsonrpc: "2.0", method });

describe("the world server's REST routes", () => {
  it("calls a tool at /tools/<name> and at its http route, with the statuses a real API would use", async () => {
    const { server, runner, session } = await served();
    expect((await post(`${session.urls.url}/tools/verify_carrier`, { mc_number: "100101" })).body).toMatchObject({ name: "Blue Mesa Trucking" });
    // The http route takes its arguments from the path, the query string and the body.
    expect((await json(`${server.url}/s/${session.id}/loads/L-1001`)).body).toMatchObject({ load_id: "L-1001", status: "available" });
    const found = await json(`${session.urls.url}/loads?origin=Dallas&destination=Atlanta&equipment=dry_van`);
    expect(found.body.map((l: { load_id: string }) => l.load_id)).toEqual(["L-1001"]);
    expect(await post(`${session.urls.url}/bookings`, BOOK)).toMatchObject({ status: 200, body: { load_id: "L-1001", status: "confirmed" } });
    // A tool error: 409 for a broken precondition, 404 for a row that isn't there, 400 for invalid arguments.
    expect(await post(`${session.urls.url}/bookings`, BOOK)).toMatchObject({ status: 409, body: { error: "Load L-1001 is not available" } });
    expect(await json(`${session.urls.url}/loads/L-9999`)).toMatchObject({ status: 404, body: { error: "loads L-9999 not found" } });
    expect(await post(`${session.urls.url}/tools/book_load`, { load_id: "L-1002" })).toMatchObject({ status: 400, body: { error: 'missing required argument "mc_number"' } });
    // Every call landed in the trial's log, marked as having come over REST.
    expect(runner.calls.map((c) => [c.name, c.ok])).toEqual([["verify_carrier", true], ["get_load", true], ["search_loads", true], ["book_load", true], ["book_load", false], ["get_load", false], ["book_load", false]]);
    // A wrong URL isn't a call.
    expect(await json(`${session.urls.url}/tools/book_lode`, { method: "POST", body: "{}" })).toMatchObject({ status: 404, body: { error: 'unknown tool "book_lode"' } });
    expect((await json(`${session.urls.url}/nowhere`)).status).toBe(404);
    expect((await json(`${session.urls.url}/bookings`)).status).toBe(405);
    expect((await json(`${session.urls.url}/tools/get_load`)).status).toBe(405);
    expect((await json(`${session.urls.url}/tools/get_load`, { method: "POST", body: "{not json" })).status).toBe(400);
    expect(runner.calls).toHaveLength(7);
  });

  it("answers a fault with its status: 504 for a timeout, 429 with Retry-After, the 5xx of a server error, after its latency", async () => {
    const { session, runner } = await served(
      task({
        faults: [
          { tool: "book_load", call: 1, error: "timeout", after_commit: true, latency_ms: 40 },
          { tool: "search_loads", call: 1, error: "rate_limit", retry_after: 3 },
          { tool: "get_load", call: 1, error: "server_error", status: 502 },
        ],
      }),
    );
    const started = performance.now();
    expect(await post(`${session.urls.url}/bookings`, BOOK)).toMatchObject({ status: 504, body: { error: "book_load timed out: no response from the server" } });
    expect(performance.now() - started).toBeGreaterThanOrEqual(35);
    const limited = await json(`${session.urls.url}/loads?origin=Dallas`);
    expect(limited).toMatchObject({ status: 429, body: { error: /^429 Too Many Requests/ } });
    expect(limited.headers.get("retry-after")).toBe("3");
    expect((await json(`${session.urls.url}/loads/L-1001`)).status).toBe(502);
    expect((await json(`${session.urls.url}/loads/L-1001`)).body).toMatchObject({ status: "booked" });
    expect(runner.calls[0]!.fault).toEqual({ error: "timeout", status: 504, latencyMs: 40, committed: true });
  });

  it("sends a URL without a session to the one trial that is running, and refuses it when there are none or several", async () => {
    const { domain, server, session } = await served();
    expect((await post(`${server.url}/tools/get_load`, { load_id: "L-1001" })).status).toBe(200);
    const other = server.open(domain.tasks[0]!, createToolRunner(domain, worldFor(domain), undefined));
    expect(await post(`${server.url}/tools/get_load`, { load_id: "L-1001" })).toMatchObject({ status: 409, body: { error: /2 trials are running at once.*\/s\/<session>/ } });
    expect((await post(`${other.urls.url}/tools/get_load`, { load_id: "L-1001" })).status).toBe(200);
    server.close(other.id);
    server.close(session.id);
    expect(await post(`${server.url}/tools/get_load`, { load_id: "L-1001" })).toMatchObject({ status: 409, body: { error: "no trial is running right now" } });
    expect(await post(`${session.urls.url}/tools/get_load`, { load_id: "L-1001" })).toMatchObject({ status: 404, body: { error: /no session t1 is open/ } });
  });

  it("describes what it serves at GET /", async () => {
    const { server, session } = await served();
    const info = (await json(`${server.url}/`)).body;
    expect(info).toMatchObject({ server: "sandtable", domain: "freight-carrier-sales", mcp: `${server.url}/mcp`, webhook: `${server.url}/webhook`, sessions: [{ id: session.id, task: "book", ...session.urls }] });
    expect(info.rest.routes).toContain(`GET ${server.url}/loads/{load_id}`);
    expect((await json(`${session.urls.url}/`)).body).toMatchObject({ session: session.id, task: "book", mcp: session.urls.mcp });
  });
});

describe("the world server's guards", () => {
  it("answers malformed percent-encoding with 400, not 500", async () => {
    const { server, session } = await served();
    expect(await post(`${server.url}/tools/%E0%A4%A`, {})).toMatchObject({ status: 400, body: { error: "malformed percent-encoding in the path: %E0%A4%A" } });
    expect((await json(`${session.urls.url}/loads/%E0%A4%A`)).status).toBe(400);
    expect((await post(`${session.urls.url}/webhook/%E0%A4%A`, {})).status).toBe(400);
    expect((await post(`${server.url}/s/%E0%A4%A/mcp`, {})).status).toBe(400);
  });

  it("refuses a request from a web page on another origin, as MCP's transport asks", async () => {
    const { server, session } = await served();
    const from = (origin: string) => json(`${session.urls.url}/loads/L-1001`, { headers: { origin } });
    expect(await from("https://evil.example")).toMatchObject({ status: 403, body: { error: /requests from a web page \(Origin: https:\/\/evil\.example\) are refused/ } });
    expect((await from("null")).status).toBe(403);
    expect((await from(server.url)).status).toBe(200);
    expect((await json(`${session.urls.url}/loads/L-1001`)).status).toBe(200);
  });

  it("closes the connection after a 413, so the next request on a pooled connection doesn't hang", async () => {
    const { session } = await served();
    const big = await fetch(`${session.urls.url}/tools/get_load`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ load_id: "x".repeat(1_200_000) }) });
    expect(big.status).toBe(413);
    expect(big.headers.get("connection")).toBe("close");
    await big.text();
    const next = await fetch(`${session.urls.url}/loads/L-1001`, { signal: AbortSignal.timeout(3000) });
    expect(next.status).toBe(200);
  });

  it("answers an MCP body that isn't JSON, or an empty batch, with a JSON-RPC error", async () => {
    const { session } = await served();
    expect(await json(session.urls.mcp, { method: "POST", body: "{oops" })).toMatchObject({ status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32700 } } });
    expect(await post(session.urls.mcp, [])).toMatchObject({ status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32600 } } });
  });

  it("leaves a tool's http route out of the task's inputs hash: it changes where the agent calls, not what it is given", async () => {
    const domain = await domainWith(task());
    const bare = { ...domain, tools: domain.tools.map(({ http: _, ...t }) => t) };
    expect(taskFingerprints(domain, domain.tasks[0]!, "scripted")).toEqual(taskFingerprints(bare, domain.tasks[0]!, "scripted"));
  });
});

describe("the world server's MCP endpoint", () => {
  it("initializes, lists the tools and calls them, over Streamable HTTP with JSON responses", async () => {
    const { session, runner, domain } = await served();
    const init = await rpc(session.urls.mcp, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    expect(init.body).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "sandtable" } } });
    expect((await rpc(session.urls.mcp, "initialize", { protocolVersion: "1999-01-01" })).body.result.protocolVersion).toBe(MCP_VERSIONS[0]);
    expect(await notify(session.urls.mcp, "notifications/initialized")).toMatchObject({ status: 202, body: undefined });
    const list = (await rpc(session.urls.mcp, "tools/list")).body.result.tools;
    expect(list.map((t: { name: string }) => t.name)).toEqual(domain.tools.map((t) => t.name));
    expect(list[0]).toMatchObject({ name: "verify_carrier", inputSchema: { type: "object", required: ["mc_number"] } });
    const ok = (await rpc(session.urls.mcp, "tools/call", { name: "get_load", arguments: { load_id: "L-1001" } })).body.result;
    expect(ok.isError).toBe(false);
    expect(JSON.parse(ok.content[0].text)).toMatchObject({ load_id: "L-1001" });
    expect((await rpc(session.urls.mcp, "tools/call", { name: "get_load", arguments: { load_id: "L-9" } })).body.result).toEqual({ content: [{ type: "text", text: "loads L-9 not found" }], isError: true });
    expect((await rpc(session.urls.mcp, "ping")).body).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect((await rpc(session.urls.mcp, "resources/list")).body.error).toMatchObject({ code: -32601 });
    // A batch, as older clients send.
    const batch = await post(session.urls.mcp, [
      { jsonrpc: "2.0", id: 7, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]);
    expect(batch.body).toEqual([{ jsonrpc: "2.0", id: 7, result: {} }]);
    expect((await json(session.urls.mcp)).status).toBe(405);
    expect(runner.calls.map((c) => c.name)).toEqual(["get_load", "get_load"]);
  });
});

describe("the world server's webhook", () => {
  it("answers Vapi's tool-calls message with results by toolCallId, as status 200 even for a tool error", async () => {
    const { session, runner } = await served();
    const vapi = await post(session.urls.webhook, {
      message: {
        type: "tool-calls",
        call: { id: "call-1" },
        toolCallList: [
          { id: "tc1", type: "function", function: { name: "verify_carrier", arguments: { mc_number: "100101" } } },
          { id: "tc2", type: "function", function: { name: "get_load", arguments: '{"load_id":"L-9"}' } },
        ],
      },
    });
    expect(vapi.status).toBe(200);
    expect(vapi.body.results[0]).toMatchObject({ toolCallId: "tc1", result: expect.stringContaining('"name":"Blue Mesa Trucking"') });
    expect(vapi.body.results[1]).toEqual({ toolCallId: "tc2", error: "loads L-9 not found" });
    // Other server messages need no answer.
    expect(await post(session.urls.webhook, { message: { type: "status-update", status: "in-progress" } })).toMatchObject({ status: 200, body: {} });
    expect(await post(session.urls.webhook, { message: { type: "end-of-call-report", artifact: { messages: [] } } })).toMatchObject({ status: 200, body: {} });
    expect(runner.calls.map((c) => [c.name, c.ok])).toEqual([["verify_carrier", true], ["get_load", false]]);
  });

  it("answers Retell's custom function, a generic call and the arguments alone at /webhook/<tool>", async () => {
    const { session, runner } = await served();
    expect(await post(session.urls.webhook, { name: "get_load", args: { load_id: "L-1001" }, call: { call_id: "r1" } })).toMatchObject({ status: 200, body: { load_id: "L-1001" } });
    expect(await post(session.urls.webhook, { name: "get_load", arguments: { load_id: "L-9" } })).toMatchObject({ status: 200, body: { error: "loads L-9 not found" } });
    expect(await post(`${session.urls.webhook}/verify_carrier`, { mc_number: "100101" })).toMatchObject({ status: 200, body: { name: "Blue Mesa Trucking" } });
    expect(await post(`${session.urls.webhook}/get_load`, { name: "get_load", args: { load_id: "L-1002" }, call: {} })).toMatchObject({ body: { load_id: "L-1002" } });
    expect(await post(session.urls.webhook, { hello: "world" })).toMatchObject({ status: 400, body: { error: /unrecognized webhook payload/ } });
    expect(runner.calls.map((c) => c.name)).toEqual(["get_load", "get_load", "verify_carrier", "get_load"]);
  });

  it("answers a faulted call with the fault's status, so Vapi says no result came back", async () => {
    const { session } = await served(task({ faults: [{ tool: "book_load", error: "rate_limit", retry_after: 2 }] }));
    const r = await post(session.urls.webhook, { message: { type: "tool-calls", toolCallList: [{ id: "x", function: { name: "book_load", arguments: BOOK } }] } });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("2");
  });
});

describe("run --serve", () => {
  /** An agent that calls its tools itself over the trial's URLs and never uses callTool, as a black-box agent does. */
  function blackBoxAgent(seen: AgentContext[]): AgentAdapter {
    return {
      name: "black-box",
      async createSession(ctx) {
        seen.push(ctx);
        const w = ctx.world!;
        let turn = 0;
        return {
          async reply(_text: string, _callTool: CallTool) {
            turn++;
            if (turn === 1) {
              await rpc(w.mcp, "tools/call", { name: "verify_carrier", arguments: { mc_number: "100101" } });
              await json(`${w.url}/loads/L-1001`);
              return "L-1001 pays $2100. Want it?";
            }
            if (turn === 2) {
              await post(w.webhook, { message: { type: "tool-calls", toolCallList: [{ id: "b", function: { name: "book_load", arguments: BOOK } }] } });
              return "Booked.";
            }
            return "Thanks for calling.";
          },
        };
      },
    };
  }

  /** The same calls, in process. */
  const inProcess: AgentAdapter = {
    name: "in-process",
    async createSession() {
      let turn = 0;
      return {
        async reply(_text: string, callTool: CallTool) {
          turn++;
          if (turn === 1) {
            await callTool("verify_carrier", { mc_number: "100101" });
            await callTool("get_load", { load_id: "L-1001" });
            return "L-1001 pays $2100. Want it?";
          }
          if (turn === 2) {
            await callTool("book_load", BOOK);
            return "Booked.";
          }
          return "Thanks for calling.";
        },
      };
    },
  };

  it("grades an agent that only calls the served world as it grades the same calls in process", async () => {
    const domain = await domainWith(task(), task({ id: "refuse", expect: { state: [{ table: "bookings", count: 0 }] } }));
    const server = await serve(domain);
    const seen: AgentContext[] = [];
    const black = await runSuite({ domain, agent: blackBoxAgent(seen), user: scriptedUser(), concurrency: 1, server });
    const plain = await runSuite({ domain, agent: inProcess, user: scriptedUser(), concurrency: 1 });
    const strip = (r: SuiteResult) => r.tasks.map((t) => ({ id: t.id, passes: t.passes, trials: t.trials.map((tr) => ({ checks: tr.checks, violations: tr.violations, changes: tr.changes, events: tr.events.map((e) => (e.type === "agent" ? { ...e, latencyMs: 0 } : e.type === "tool" ? { ...e, via: undefined } : e)) })) }));
    expect(JSON.parse(JSON.stringify(strip(black)))).toEqual(JSON.parse(JSON.stringify(strip(plain))));
    expect(black.tasks.map((t) => t.passes)).toEqual([1, 0]);
    expect(black.tasks[0]!.trials[0]!.events.filter((e) => e.type === "tool").map((e) => e.type === "tool" && e.via)).toEqual(["mcp", "rest", "webhook"]);
    // Each trial got its own URLs, and they stopped answering when it ended.
    expect(seen.map((c) => c.world!.url)).toEqual([`${server.url}/s/t1`, `${server.url}/s/t2`]);
    expect((await post(`${seen[0]!.world!.url}/tools/get_load`, { load_id: "L-1001" })).status).toBe(404);
  });

  it("sends the trial's URLs to an HTTP agent as world, on every request", async () => {
    const domain = await domainWith(task());
    const server = await serve(domain);
    const bodies: { world?: WorldUrls; message?: string }[] = [];
    const agentServer = createServer(async (req, res) => {
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text) as { world?: WorldUrls; message?: string };
      bodies.push(body);
      if (body.message?.startsWith("MC")) await fetch(`${body.world!.url}/carriers/100101`);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ reply: "ok" }));
    });
    await new Promise<void>((resolve) => agentServer.listen(0, "127.0.0.1", resolve));
    const { port } = agentServer.address() as { port: number };
    try {
      const r = await runEpisode({ domain, task: domain.tasks[0]!, agent: httpAgent(`http://127.0.0.1:${port}/step`), user: scriptedUser(), trial: 0, server });
      expect(bodies.length).toBeGreaterThan(0);
      for (const b of bodies) expect(b.world).toEqual({ url: `${server.url}/s/t1`, mcp: `${server.url}/s/t1/mcp`, webhook: `${server.url}/s/t1/webhook` });
      expect(r.events.filter((e) => e.type === "tool")).toMatchObject([{ name: "verify_carrier", ok: true, via: "rest" }]);
    } finally {
      agentServer.close();
    }
    // Without a server, no world.
    const quiet: AgentContext[] = [];
    await runEpisode({ domain, task: domain.tasks[0]!, agent: { name: "x", async createSession(ctx) { quiet.push(ctx); return { reply: async () => "ok" }; } }, user: scriptedUser(), trial: 0 });
    expect(quiet[0]).not.toHaveProperty("world");
  });

  it.skipIf(!process.features.typescript)("serves the world from the CLI, one trial at a time by default, for an agent with a fixed URL", { timeout: 30_000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-serve-"));
    const agentFile = path.join(dir, "agent.mjs");
    // The agent knows only the server's base URL, from the environment, as an unmodified agent would.
    await writeFile(
      agentFile,
      `export default { name: "fixed-url", async createSession() { let t = 0; return { async reply() { t++;
        const base = process.env.WORLD;
        if (t === 1) { await fetch(base + "/carriers/100101"); return "Want L-1001?"; }
        if (t === 2) { await fetch(base + "/bookings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(${JSON.stringify(BOOK)}) }); return "Booked."; }
        return "Bye."; } }; } };\n`,
    );
    const out = path.join(dir, "run");
    const port = await freePort();
    const { stdout } = await promisify(execFile)(process.execPath, [cli, "run", example, "--agent", agentFile, "--user", "scripted", "--tasks", "book-at-posted-rate,expired-insurance", "--serve", String(port), "-o", out, "--no-html"], {
      env: { ...process.env, WORLD: `http://127.0.0.1:${port}` },
    }).catch((err: { stdout: string; stderr: string }) => err);
    expect(stdout).toContain(`Serving each trial's world at http://127.0.0.1:${port} while it runs`);
    expect(stdout).toContain("Trials run one at a time, so these URLs mean the trial that is running.");
    const result = JSON.parse(await readFile(path.join(out, "results.json"), "utf8")) as SuiteResult;
    const [book, refuse] = result.tasks;
    expect(book!.trials[0]!.events.filter((e) => e.type === "tool").map((e) => e.type === "tool" && `${e.name} ${e.via}`)).toEqual(["verify_carrier rest", "book_load rest"]);
    expect(book!.passes).toBe(1);
    // The same booking fails a task that must book nothing, graded through the served world as in process.
    expect(refuse!.trials[0]!.checks.filter((c) => !c.passed).map((c) => c.id)).toEqual(["state:bookings#1"]);
  });

  it("rejects a port that isn't one", async () => {
    const r = await promisify(execFile)(process.execPath, [cli, "run", example, "--serve", "http"]).catch((err: { code: number; stderr: string }) => err);
    expect(r).toMatchObject({ code: 2, stderr: expect.stringContaining("must be a port number") });
  });
});

describe("a tool's http route in the spec", () => {
  it("validate names a placeholder that isn't a scalar param, a route the server keeps, and two tools on one route", async () => {
    const d = await loadDomain(example);
    const withHttp = (name: string, http: unknown) => ({ ...d, tools: d.tools.map((t) => (t.name === name ? { ...t, http } : t)) }) as Domain;
    expect(validateDomain(withHttp("get_load", { method: "GET", path: "/loads/{id}" }))).toEqual(["tools.get_load.http: {id} is not a param of get_load"]);
    expect(validateDomain(withHttp("get_load", { method: "GET", path: "/mcp/{load_id}" }))).toEqual([expect.stringMatching(/tools\.get_load\.http: \/mcp\/\{load_id\} is one of the world server's own routes/)]);
    expect(validateDomain(withHttp("get_load", { method: "GET", path: "/carriers/{load_id}" }))).toEqual(["tools.get_load.http: GET /carriers/{load_id} is tools.verify_carrier's route too"]);
    expect(validateDomain(withHttp("get_load", { method: "PUT", path: "/carriers/{load_id}" }))).toEqual([]);
  });
});
