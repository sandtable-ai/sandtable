import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FaultApplied } from "../grade/invariants.ts";
import { callLive, type CallVia, type ToolRunner } from "../run/tool-runner.ts";
import type { WorldUrls } from "../sim/types.ts";
import type { Domain, Task, Tool } from "../spec/schema.ts";
import { version } from "../version.ts";
import { isPlainObject } from "../world/match.ts";
import { coerceArgs, type ToolOutcome } from "../world/tools.ts";
import { mcpBody, type McpCall } from "./mcp.ts";
import { parseWebhook, webhookAnswer, type TranscriptLine, type WebhookResult } from "./webhook.ts";

/**
 * Serves the simulated world over HTTP, so an agent that calls its tools itself, against the customer's API, an MCP
 * server or a platform's webhook, can be rehearsed: `run --serve` drives the conversation, and each trial's world is a
 * session here. Every call goes through the trial's tool runner, as an in-process call does, so it is checked against
 * the invariants, a task's faults hit it, and it lands in the trial's log.
 *
 * Routes, under the base URL and under each session's `/s/<id>`:
 * - `GET /`: what is served, as JSON.
 * - `POST /tools/<name>`: call a tool with the JSON body as its arguments.
 * - A tool's `http` route, such as `GET /loads/{load_id}`: arguments from the path, the query string and a JSON body.
 * - `POST /mcp`: the tools as an MCP server (see mcp.ts).
 * - `POST /webhook`, `POST /webhook/<tool>`: a hosted platform's tool calls (see webhook.ts).
 * The base URL's routes go to the one trial that is running, so an agent configured with a fixed URL works when trials
 * run one at a time.
 */

export interface ServedSession {
  id: string;
  task: Task;
  runner: ToolRunner;
  urls: WorldUrls;
}

export interface WorldServer {
  /** The base URL, such as `http://127.0.0.1:4010`. */
  url: string;
  /** Serve one trial's world, through the runner its episode uses. */
  open(task: Task, runner: ToolRunner): ServedSession;
  /** Stop serving a trial: its URLs answer 404 from then on. */
  close(id: string): void;
  stop(): Promise<void>;
}

export interface WorldServerOptions {
  /** 0 picks a free port. */
  port: number;
  /** The address to listen on: 127.0.0.1 unless the agent runs elsewhere. */
  host?: string;
  /** For conversations another system drives (`sandtable serve`): how sessions open and end without a run. */
  driven?: DrivenSessions;
}

/**
 * How `sandtable serve` opens and ends sessions, which another system's conversations drive. With it, a request that
 * names no session opens one when none is open; a platform's call id and an MCP connection each get their own; and
 * `POST /sessions`, `POST /sessions/<id>/end`, an MCP `DELETE`, Vapi's end-of-call-report and Retell's `call_ended`
 * become routes.
 */
export interface DrivenSessions {
  /** Open a session for a conversation: a trial of `taskId`, or of the default task when undefined. Throws to refuse. */
  open(taskId: string | undefined): ServedSession;
  /** The conversation is over: grade it, with what was said when the platform sent it, and return what to answer. */
  end(session: ServedSession, transcript: TranscriptLine[] | undefined): unknown | Promise<unknown>;
}

/** A Host header that names this machine: 127.0.0.1, localhost or [::1], with any port. */
const LOOPBACK = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;

/** The largest request body read, in bytes. */
const MAX_BODY = 1_000_000;
/** The most of a larger body read, and dropped, before the 413: past it, the connection is dropped instead. */
const MAX_DRAIN = 16_000_000;

/** A request the server answers with this status and the message as `{ error }`, and any headers it needs. */
export class HttpError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

/** A percent-encoded path part, decoded; malformed encoding is the client's error. */
function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new HttpError(400, `malformed percent-encoding in the path: ${part}`);
  }
}

interface Route {
  tool: Tool;
  method: string;
  pattern: RegExp;
  names: string[];
}

/** A tool's `http` route as a pattern: each `{param}` matches one path segment, and a trailing slash is optional. */
function routeOf(tool: Tool): Route | undefined {
  if (!tool.http) return undefined;
  const names: string[] = [];
  const source = tool.http.path
    .replace(/\/+$/, "")
    .split(/(\{[^}]*\})/)
    .map((part) => {
      const m = /^\{([^}]*)\}$/.exec(part);
      if (!m) return part.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
      names.push(m[1]!);
      return "([^/]+)";
    })
    .join("");
  return { tool, method: tool.http.method, pattern: new RegExp(`^${source}/?$`), names };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_DRAIN) {
      // Far too large to read to the end: drop the connection.
      req.destroy();
      break;
    }
    // Read to the end without keeping it, so the client finishes sending and reads the answer.
    if (size <= MAX_BODY) chunks.push(chunk as Buffer);
  }
  if (size > MAX_BODY) throw new HttpError(413, `the request body is over ${MAX_BODY} bytes`, { connection: "close" });
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "the request body is not JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers });
  res.end(text);
}

/** The query string as arguments: a name given more than once is a list. */
function queryArgs(url: URL): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(name);
    out[name] = all.length > 1 ? all : all[0];
  }
  return out;
}

export async function startWorldServer(domain: Domain, opts: WorldServerOptions): Promise<WorldServer> {
  const tools = new Map(domain.tools.map((t) => [t.name, t]));
  const routes = domain.tools.flatMap((t) => routeOf(t) ?? []);
  const sessions = new Map<string, ServedSession>();
  /** Driven sessions by a platform's call id. */
  const byCall = new Map<string, string>();
  /** The call ids whose conversation ended: a platform's retry of a webhook for one must not open a new one. */
  const endedCalls = new Set<string>();
  /**
   * Driven sessions a platform's call id or an MCP connection names. A request that names no session never goes to one,
   * so a conversation that never ended, such as an MCP client that doesn't send DELETE, can't catch others' requests.
   */
  const keyedIds = new Set<string>();
  const driven = opts.driven;
  let next = 1;
  let base = "";

  /** The session a request without `/s/<id>` is for: the one trial that is running, or, driven, a new one. */
  function current(): ServedSession {
    const open = [...sessions.values()].filter((s) => !keyedIds.has(s.id));
    if (open.length === 1) return open[0]!;
    if (open.length === 0) {
      if (driven) return driven.open(undefined);
      throw new HttpError(409, "no trial is running right now");
    }
    throw new HttpError(
      409,
      driven
        ? `${open.length} conversations are open at once, so a URL without a session is ambiguous: use the session's own URL (/s/<session>/…), which POST /sessions returns`
        : `${open.length} trials are running at once, so a URL without a session is ambiguous: use the trial's own URL (/s/<session>/…), or run trials one at a time (--concurrency 1)`,
    );
  }

  /** A driven session by a platform's call id: the one it opened, or a new one. */
  function forCall(callId: string): ServedSession {
    const open = sessions.get(byCall.get(callId) ?? "");
    if (open) return open;
    if (endedCalls.has(callId)) throw new HttpError(409, `call ${callId} has ended, and its conversation was graded`);
    const s = driven!.open(undefined);
    byCall.set(callId, s.id);
    keyedIds.add(s.id);
    return s;
  }

  /** End a driven session: grade it, stop serving it, and answer with the grade once the run's files have it. */
  async function finish(res: ServerResponse, s: ServedSession, transcript: TranscriptLine[] | undefined): Promise<void> {
    sessions.delete(s.id);
    keyedIds.delete(s.id);
    for (const [call, id] of byCall) {
      if (id !== s.id) continue;
      byCall.delete(call);
      endedCalls.add(call);
    }
    send(res, 200, await driven!.end(s, transcript));
  }

  /** A transcript as `POST /sessions/<id>/end` takes it: `[{ role: "user" | "agent" | "assistant", text, time? }]`. */
  function transcriptOf(body: unknown): TranscriptLine[] | undefined {
    if (body === undefined || (isPlainObject(body) && body.transcript === undefined)) return undefined;
    const lines = isPlainObject(body) ? body.transcript : undefined;
    if (!Array.isArray(lines)) throw new HttpError(400, "transcript must be a list of { role, text } lines");
    return lines.map((l, i) => {
      const text = isPlainObject(l) ? (l.text ?? l.content ?? l.message) : undefined;
      const role = isPlainObject(l) ? (l.role === "user" ? "user" : l.role === "agent" || l.role === "assistant" || l.role === "bot" ? "agent" : undefined) : undefined;
      if (!role || typeof text !== "string") throw new HttpError(400, `transcript[${i}] needs a role (user or agent) and a text`);
      const t = isPlainObject(l) ? l.time : undefined;
      if (t !== undefined && (typeof t !== "number" || !Number.isFinite(t) || t < 0)) throw new HttpError(400, `transcript[${i}].time must be a time in milliseconds since the epoch`);
      return { role, text, ...(t !== undefined ? { time: t } : {}) };
    });
  }

  /** Call a tool in a session, waiting out a fault's latency. */
  const callIn = (s: ServedSession, name: string, args: unknown, via: CallVia) => callLive(s.runner, name, args, via);

  /** A REST answer: the result, or the error with a status a real API would use, or the status of a fault that hit it. */
  function restAnswer(res: ServerResponse, tool: Tool, args: unknown, { outcome, fault }: { outcome: ToolOutcome; fault?: FaultApplied }): void {
    if (fault?.status !== undefined) {
      send(res, fault.status, { error: outcome.error }, fault.retryAfter !== undefined ? { "retry-after": String(fault.retryAfter) } : {});
    } else if (outcome.ok) {
      send(res, 200, outcome.result ?? null);
    } else {
      const status = "error" in coerceArgs(tool, args) ? 400 : /\bnot found\b/i.test(outcome.error ?? "") ? 404 : 409;
      send(res, status, { error: outcome.error });
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A web page could reach this server through the browser: refuse a request from another origin, as MCP's transport
    // asks a local server to. Agents, curl and platforms' webhooks send no Origin.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${req.headers.host}`) {
      throw new HttpError(403, `requests from a web page (Origin: ${origin}) are refused: the world server is for agents, not browsers`);
    }
    // Listening on this machine only, a request must name it too: another name that resolves here is DNS rebinding.
    if (loopback && !LOOPBACK.test(req.headers.host ?? "")) {
      throw new HttpError(403, `requests for another host (Host: ${req.headers.host ?? "none"}) are refused: the world server listens on this machine only`);
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    let path = url.pathname;
    let session: ServedSession | undefined;
    const scoped = /^\/s\/([^/]+)(\/.*)?$/.exec(path);
    if (scoped) {
      const id = decode(scoped[1]!);
      session = sessions.get(id);
      if (!session) throw new HttpError(404, `no session ${id} is open: its trial ended, or it never started`);
      path = scoped[2] ?? "/";
    }
    const target = () => session ?? current();
    const method = req.method ?? "GET";

    if (path === "/" || path === "") {
      if (method !== "GET") throw new HttpError(405, "GET / describes what is served");
      const at = session ? session.urls : { url: base, mcp: `${base}/mcp`, webhook: `${base}/webhook` };
      send(res, 200, {
        server: "sandtable",
        version,
        domain: domain.name,
        ...(session ? { session: session.id, task: session.task.id } : { sessions: [...sessions.values()].map((s) => ({ id: s.id, task: s.task.id, ...s.urls })) }),
        rest: { tools: `${at.url}/tools/<name>`, routes: routes.map((r) => `${r.method} ${at.url}${r.tool.http!.path}`) },
        mcp: at.mcp,
        webhook: at.webhook,
      });
      return;
    }

    if (driven && !session && path.startsWith("/sessions")) {
      const end = /^\/sessions\/([^/]+)\/end\/?$/.exec(path);
      if (end) {
        if (method !== "POST") throw new HttpError(405, "POST /sessions/<id>/end, with { transcript } when you have it");
        const id = decode(end[1]!);
        const s = sessions.get(id);
        if (!s) throw new HttpError(404, `no session ${id} is open: it ended, or it never started`);
        await finish(res, s, transcriptOf(await readBody(req)));
        return;
      }
      if (path === "/sessions" || path === "/sessions/") {
        if (method === "GET") return send(res, 200, [...sessions.values()].map((s) => ({ id: s.id, task: s.task.id, ...s.urls })));
        if (method !== "POST") throw new HttpError(405, "POST /sessions opens a conversation; GET /sessions lists the open ones");
        const body = await readBody(req);
        if (body !== undefined && (!isPlainObject(body) || (body.task !== undefined && typeof body.task !== "string"))) {
          throw new HttpError(400, 'POST /sessions takes no body, or { "task": "<id>" }');
        }
        const s = driven.open(isPlainObject(body) ? (body.task as string | undefined) : undefined);
        return send(res, 201, { id: s.id, task: s.task.id, ...s.urls });
      }
    }

    if (path === "/mcp") {
      // Driven, an MCP connection is a conversation: initialize opens a session and names it in Mcp-Session-Id,
      // later requests carry it, and DELETE ends it.
      const header = req.headers["mcp-session-id"];
      const mcpId = driven && !session && typeof header === "string" ? header : undefined;
      const mcpSession = mcpId === undefined ? undefined : sessions.get(mcpId);
      if (mcpId !== undefined && !mcpSession) throw new HttpError(404, `no session ${mcpId} is open: initialize again`);
      if (method === "DELETE" && mcpSession) {
        await finish(res, mcpSession, undefined);
        return;
      }
      if (method !== "POST") {
        res.setHeader("allow", driven ? "POST, DELETE" : "POST");
        throw new HttpError(405, "the MCP endpoint takes POST only: it doesn't open an SSE stream");
      }
      let body: unknown;
      try {
        body = await readBody(req);
      } catch (err) {
        // JSON-RPC's own error for a body that isn't JSON, in a JSON-RPC body.
        if (err instanceof HttpError && err.status === 400) return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${err.message}` } });
        throw err;
      }
      if (body === undefined || (Array.isArray(body) && body.length === 0)) {
        return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: an empty body or batch" } });
      }
      let opened: ServedSession | undefined;
      if (driven && !session && !mcpSession && isPlainObject(body) && body.method === "initialize") {
        opened = driven.open(undefined);
        keyedIds.add(opened.id);
        res.setHeader("mcp-session-id", opened.id);
      }
      const call: McpCall = async (name, args) => {
        let s: ServedSession;
        try {
          s = mcpSession ?? opened ?? target();
        } catch (err) {
          return { noTrial: (err as Error).message };
        }
        return (await callIn(s, name, args, "mcp")).outcome;
      };
      const out = await mcpBody(domain, body, call);
      if (out === undefined) send(res, 202, undefined);
      else send(res, 200, out);
      return;
    }

    const hook = /^\/webhook(?:\/([^/]+))?\/?$/.exec(path);
    if (hook) {
      if (method !== "POST") throw new HttpError(405, "the webhook takes POST");
      const request = parseWebhook(await readBody(req), hook[1] === undefined ? undefined : decode(hook[1]));
      if (request.kind === "invalid") throw new HttpError(400, request.error);
      // Driven, a platform's call id names the conversation: its first webhook opens a session for it.
      const keyed = () => (driven && !session && request.callId !== undefined ? forCall(request.callId) : target());
      if (request.kind === "end" && driven) {
        // A platform's retry of an end it already sent is answered, not graded again.
        if (!session && request.callId !== undefined && endedCalls.has(request.callId)) {
          send(res, 200, { ignored: `call ${request.callId} has ended, and its conversation was graded` });
          return;
        }
        // A call with no tool call is still a trial: its end opens and grades one.
        await finish(res, keyed(), request.transcript);
        return;
      }
      if (request.kind !== "calls") {
        send(res, 200, {});
        return;
      }
      const s = keyed();
      const results: WebhookResult[] = [];
      for (const call of request.calls) results.push({ call, ...(await callIn(s, call.name, call.args, "webhook")) });
      const answer = webhookAnswer(request.platform, results);
      send(res, answer.status, answer.body, answer.headers);
      return;
    }

    const named = /^\/tools\/([^/]+)\/?$/.exec(path);
    if (named) {
      const name = decode(named[1]!);
      const tool = tools.get(name);
      if (!tool) throw new HttpError(404, `unknown tool "${name}"`);
      if (method !== "POST") throw new HttpError(405, `POST /tools/${name} with the arguments as a JSON object`);
      const args = (await readBody(req)) ?? {};
      restAnswer(res, tool, args, await callIn(target(), tool.name, args, "rest"));
      return;
    }

    for (const route of routes) {
      const m = route.pattern.exec(path);
      if (!m || route.method !== method) continue;
      const body = await readBody(req);
      if (body !== undefined && !isPlainObject(body)) throw new HttpError(400, "the request body must be a JSON object");
      const fromPath = Object.fromEntries(route.names.map((name, i) => [name, decode(m[i + 1]!)]));
      const args = { ...queryArgs(url), ...body, ...fromPath };
      restAnswer(res, route.tool, args, await callIn(target(), route.tool.name, args, "rest"));
      return;
    }
    const other = routes.find((r) => r.pattern.test(path));
    if (other) throw new HttpError(405, `${path} takes ${routes.filter((r) => r.pattern.test(path)).map((r) => r.method).join(", ")}`);
    throw new HttpError(404, `no route ${method} ${path}: use /tools/<name>, /mcp, /webhook${routes.length ? ", or a tool's http route" : ""}`);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return send(res, err.status, { error: err.message }, err.headers);
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });
  const host = opts.host ?? "127.0.0.1";
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  base = `http://${host.includes(":") ? `[${host}]` : host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;

  return {
    url: base,
    open(task, runner) {
      const id = `t${next++}`;
      const at = `${base}/s/${id}`;
      const session = { id, task, runner, urls: { url: at, mcp: `${at}/mcp`, webhook: `${at}/webhook` } };
      sessions.set(id, session);
      return session;
    },
    close(id) {
      sessions.delete(id);
    },
    stop() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
