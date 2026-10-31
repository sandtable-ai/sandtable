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
import { parseWebhook, webhookAnswer, type WebhookResult } from "./webhook.ts";

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
}

/** The largest request body read, in bytes. */
const MAX_BODY = 1_000_000;

/** A request the server answers with this status and the message as `{ error }`. */
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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
    if (size > MAX_BODY) throw new HttpError(413, `the request body is over ${MAX_BODY} bytes`);
    chunks.push(chunk as Buffer);
  }
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
  let next = 1;
  let base = "";

  /** The session a request without `/s/<id>` is for: the one trial that is running. */
  function current(): ServedSession {
    if (sessions.size === 1) return sessions.values().next().value!;
    if (sessions.size === 0) throw new HttpError(409, "no trial is running right now");
    throw new HttpError(409, `${sessions.size} trials are running at once, so a URL without a session is ambiguous: use the trial's own URL (/s/<session>/…), or run trials one at a time (--concurrency 1)`);
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
    const url = new URL(req.url ?? "/", "http://localhost");
    let path = url.pathname;
    let session: ServedSession | undefined;
    const scoped = /^\/s\/([^/]+)(\/.*)?$/.exec(path);
    if (scoped) {
      const id = decodeURIComponent(scoped[1]!);
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

    if (path === "/mcp") {
      if (method !== "POST") {
        res.setHeader("allow", "POST");
        throw new HttpError(405, "the MCP endpoint takes POST only: it doesn't open an SSE stream");
      }
      const call: McpCall = async (name, args) => {
        let s: ServedSession;
        try {
          s = target();
        } catch (err) {
          return { noTrial: (err as Error).message };
        }
        return (await callIn(s, name, args, "mcp")).outcome;
      };
      const out = await mcpBody(domain, await readBody(req), call);
      if (out === undefined) send(res, 202, undefined);
      else send(res, 200, out);
      return;
    }

    const hook = /^\/webhook(?:\/([^/]+))?\/?$/.exec(path);
    if (hook) {
      if (method !== "POST") throw new HttpError(405, "the webhook takes POST");
      const request = parseWebhook(await readBody(req), hook[1] === undefined ? undefined : decodeURIComponent(hook[1]));
      if (request.kind === "invalid") throw new HttpError(400, request.error);
      if (request.kind !== "calls") {
        send(res, 200, {});
        return;
      }
      const s = target();
      const results: WebhookResult[] = [];
      for (const call of request.calls) results.push({ call, ...(await callIn(s, call.name, call.args, "webhook")) });
      const answer = webhookAnswer(request.platform, results);
      send(res, answer.status, answer.body, answer.headers);
      return;
    }

    const named = /^\/tools\/([^/]+)\/?$/.exec(path);
    if (named) {
      const name = decodeURIComponent(named[1]!);
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
      const fromPath = Object.fromEntries(route.names.map((name, i) => [name, decodeURIComponent(m[i + 1]!)]));
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
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });
  const host = opts.host ?? "127.0.0.1";
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
