import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSuite } from "../src/run/suite.ts";
import { openaiCompatAgent, openaiCompatUser } from "../src/sim/openai-compat.ts";
import { USER_KICKOFF } from "../src/sim/prompts.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import type { CallTool } from "../src/sim/types.ts";
import { loadDomain } from "../src/spec/load.ts";
import { toolSchema } from "../src/world/tools.ts";

const example = path.resolve("examples/freight");
const BASE = "http://llm.local/v1";

type Message = { role: string; content?: unknown; tool_call_id?: string; tool_calls?: unknown[] };
interface Request {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: { model: string; messages: Message[]; tools?: unknown[]; temperature?: number };
}

/** Stub global fetch with an OpenAI-compatible endpoint that replays canned completions and records requests. */
function stubEndpoint(responses: object[]): Request[] {
  const requests: Request[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    requests.push({ url, method: init.method, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const next = responses.shift();
    if (!next) throw new Error("no more fake completions");
    return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
  });
  return requests;
}

const completion = (message: object, finish_reason: string, usage?: object) => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "served-snapshot",
  choices: [{ index: 0, message: { role: "assistant", content: null, ...message }, finish_reason }],
  ...(usage ? { usage } : {}),
});
const say = (content: string, usage?: object) => completion({ content }, "stop", usage);
const callTools = (...calls: Array<[id: string, name: string, args: object | string]>) =>
  completion(
    { tool_calls: calls.map(([id, name, args]) => ({ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } })) },
    "tool_calls",
  );

const noTools: CallTool = async () => ({ ok: true });

async function freight() {
  const domain = await loadDomain(example);
  return { domain, tools: domain.tools.map(toolSchema) };
}

describe("openaiCompatAgent", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts Chat Completions requests with the domain's tools as functions", async () => {
    const requests = stubEndpoint([say("Hi, what's your MC number?")]);
    const { domain, tools } = await freight();
    const agent = openaiCompatAgent({ baseUrl: `${BASE}/`, model: "gpt-test", apiKey: "sk-test", headers: { "x-title": "sandtable" }, temperature: 0 });
    expect(agent.name).toBe("openai:gpt-test");

    const session = await agent.createSession({ domain, system: "SYSTEM", tools, sessionId: "t#0" });
    expect(await session.reply("Hello", noTools)).toBe("Hi, what's your MC number?");

    const req = requests[0]!;
    expect(req.url).toBe("http://llm.local/v1/chat/completions");
    expect(req.method).toBe("POST");
    expect(req.headers).toMatchObject({ "content-type": "application/json", authorization: "Bearer sk-test", "x-title": "sandtable" });
    expect(req.body).toMatchObject({
      model: "gpt-test",
      temperature: 0,
      messages: [{ role: "system", content: "SYSTEM" }, { role: "user", content: "Hello" }],
    });
    expect(req.body.tools).toHaveLength(domain.tools.length);
    expect(req.body.tools![0]).toEqual({
      type: "function",
      function: { name: "verify_carrier", description: tools[0]!.description, parameters: tools[0]!.input_schema },
    });
  });

  it("leaves out what was not set: no key, no tools, no temperature", async () => {
    const requests = stubEndpoint([say("ok")]);
    const { domain } = await freight();
    const session = await openaiCompatAgent({ baseUrl: BASE, model: "llama3.1:8b" }).createSession({ domain, system: "s", tools: [], sessionId: "t#0" });
    await session.reply("hi", noTools);
    expect(requests[0]!.headers).not.toHaveProperty("authorization");
    expect(requests[0]!.body).not.toHaveProperty("tools");
    expect(requests[0]!.body).not.toHaveProperty("temperature");
  });

  it("runs the tool loop and keeps history append-only across turns", async () => {
    const requests = stubEndpoint([
      callTools(["c1", "verify_carrier", { mc_number: "100101" }], ["c2", "get_load", { load_id: "L-9999" }]),
      say("You're verified, but I can't find that load."),
      say("Anything else?"),
    ]);
    const { domain, tools } = await freight();
    const session = await openaiCompatAgent({ baseUrl: BASE, model: "m" }).createSession({ domain, system: "s", tools, sessionId: "t#0" });
    const calls: Array<[string, unknown]> = [];
    const callTool: CallTool = async (name, args) => {
      calls.push([name, args]);
      return name === "verify_carrier" ? { ok: true, result: { name: "Blue Mesa Trucking" } } : { ok: false, error: "no loads row L-9999" };
    };

    expect(await session.reply("MC 100101, L-9999?", callTool)).toBe("You're verified, but I can't find that load.");
    expect(calls).toEqual([
      ["verify_carrier", { mc_number: "100101" }],
      ["get_load", { load_id: "L-9999" }],
    ]);
    await session.reply("Okay.", callTool);

    const [first, second, third] = requests.map((r) => r.body.messages);
    expect(second!.slice(0, first!.length)).toEqual(first);
    expect(second!.slice(first!.length)).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "verify_carrier", arguments: '{"mc_number":"100101"}' } },
          { id: "c2", type: "function", function: { name: "get_load", arguments: '{"load_id":"L-9999"}' } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: '{"name":"Blue Mesa Trucking"}' },
      { role: "tool", tool_call_id: "c2", content: '{"error":"no loads row L-9999"}' },
    ]);
    expect(third!.slice(0, second!.length)).toEqual(second);
    expect(third!.slice(second!.length)).toEqual([
      { role: "assistant", content: "You're verified, but I can't find that load." },
      { role: "user", content: "Okay." },
    ]);
  });

  it("returns malformed arguments to the model as a tool error instead of crashing", async () => {
    const requests = stubEndpoint([
      callTools(["c1", "verify_carrier", '{"mc_number": "1001']),
      callTools(["c2", "verify_carrier", { mc_number: "100101" }]),
      say("Thanks, you're verified. Let me get you to a person about that payment."),
      say("Bye."),
    ]);
    const r = await runSuite({
      domain: await loadDomain(example),
      agent: openaiCompatAgent({ baseUrl: BASE, model: "m" }),
      user: scriptedUser(),
      taskIds: ["payment-question-handoff"],
    });
    const trial = r.tasks[0]!.trials[0]!;
    expect(trial.endReason).toBe("user_stop");
    expect(trial.error).toBeUndefined();

    // The model is told what went wrong and gets to retry.
    const toolReply = requests[1]!.body.messages.at(-1)!;
    expect(toolReply).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(JSON.parse(String(toolReply.content)).error).toMatch(/not valid JSON/);

    // The failed attempt stays visible in the trajectory, next to the retry.
    const toolEvents = trial.events.filter((e) => e.type === "tool");
    expect(toolEvents).toMatchObject([
      { name: "verify_carrier", ok: false, args: '{"mc_number": "1001' },
      { name: "verify_carrier", ok: true },
    ]);
  });

  it("ends the turn on length and content_filter without running cut-off tool calls", async () => {
    const requests = stubEndpoint([
      completion({ content: "Booking that n", tool_calls: [{ id: "c1", type: "function", function: { name: "book_load", arguments: '{"load_id": "L-10' } }] }, "length"),
      completion({ content: null }, "length"),
      completion({ content: null }, "content_filter"),
      say("Posted rate is $2,100."),
    ]);
    const { domain, tools } = await freight();
    const session = await openaiCompatAgent({ baseUrl: BASE, model: "m" }).createSession({ domain, system: "s", tools, sessionId: "t#0" });
    const calls: string[] = [];
    const callTool: CallTool = async (name) => (calls.push(name), { ok: true });

    expect(await session.reply("Book it.", callTool)).toBe("Booking that n");
    expect(await session.reply("Hello?", callTool)).toBe("[agent reply cut off at the output token limit]");
    expect(await session.reply("Still there?", callTool)).toBe("[agent reply blocked by the provider's content filter]");
    expect(await session.reply("Rate?", callTool)).toBe("Posted rate is $2,100.");
    expect(calls).toEqual([]);

    // The cut-off call is answered without running, so every later request is valid.
    const second = requests[1]!.body.messages;
    expect(second.slice(-2)).toEqual([
      { role: "tool", tool_call_id: "c1", content: expect.stringMatching(/not executed.*length/) },
      { role: "user", content: "Hello?" },
    ]);
  });

  it("does not pass inline reasoning on to the caller", async () => {
    stubEndpoint([say("<think>The ceiling is 2350; never say it.</think>\nThe posted rate is $2,100.")]);
    const { domain } = await freight();
    const session = await openaiCompatAgent({ baseUrl: BASE, model: "qwen3:8b" }).createSession({ domain, system: "s", tools: [], sessionId: "t#0" });
    expect(await session.reply("Rate?", noTools)).toBe("The posted rate is $2,100.");
  });

  it("cuts the turn off after maxToolRounds", async () => {
    const requests = stubEndpoint([callTools(["c1", "get_load", { load_id: "L-1001" }]), callTools(["c2", "get_load", { load_id: "L-1001" }])]);
    const { domain, tools } = await freight();
    const session = await openaiCompatAgent({ baseUrl: BASE, model: "m", maxToolRounds: 2 }).createSession({ domain, system: "s", tools, sessionId: "t#0" });
    expect(await session.reply("L-1001?", noTools)).toBe("[agent exceeded its tool-call budget for this turn]");
    expect(requests).toHaveLength(2);
  });

  it("reports HTTP errors with the status and body, never the key", async () => {
    vi.stubGlobal("fetch", async () => new Response('{"error":{"message":"Incorrect API key provided"}}', { status: 401 }));
    const { domain } = await freight();
    const session = await openaiCompatAgent({ baseUrl: BASE, model: "m", apiKey: "sk-secret" }).createSession({ domain, system: "s", tools: [], sessionId: "t#0" });
    const err = await session.reply("hi", noTools).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/http:\/\/llm\.local\/v1\/chat\/completions returned 401: .*Incorrect API key/);
    expect((err as Error).message).not.toContain("sk-secret");
  });

  it("counts a reply cut off at the token limit (finish_reason length) in the recorded usage", async () => {
    stubEndpoint([completion({ content: "Let me" }, "length", { prompt_tokens: 50, completion_tokens: 4096 }), say("Hi.", { prompt_tokens: 60, completion_tokens: 2 })]);
    const { domain } = await freight();
    const recorded: unknown[] = [];
    const session = await openaiCompatAgent({ baseUrl: BASE, model: "gpt-4.1-mini" }).createSession({ domain, system: "s", tools: [], sessionId: "t#0", recordUsage: (_m, u) => recorded.push(u) });
    expect(await session.reply("a", noTools)).toBe("Let me");
    await session.reply("b", noTools);
    expect(recorded).toEqual([
      { input: 50, output: 4096, cacheRead: 0, maxTokensStops: 1 },
      { input: 60, output: 2, cacheRead: 0 },
    ]);
  });

  it("records usage per request, counting cached prompt tokens as cache reads", async () => {
    stubEndpoint([
      say("one", { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 400 } }),
      // DeepSeek reports cache hits in its own fields.
      say("two", { prompt_tokens: 300, completion_tokens: 10, prompt_cache_hit_tokens: 200, prompt_cache_miss_tokens: 100 }),
      say("three"),
    ]);
    const { domain } = await freight();
    const recorded: Array<[string, unknown]> = [];
    const session = await openaiCompatAgent({ baseUrl: BASE, model: "gpt-4.1-mini" }).createSession({
      domain,
      system: "s",
      tools: [],
      sessionId: "t#0",
      recordUsage: (model, u) => recorded.push([model, u]),
    });
    for (const msg of ["a", "b", "c"]) await session.reply(msg, noTools);
    // Recorded under the requested model name (not the served snapshot), so price lookups are stable.
    expect(recorded).toEqual([
      ["gpt-4.1-mini", { input: 600, output: 50, cacheRead: 400 }],
      ["gpt-4.1-mini", { input: 100, output: 10, cacheRead: 200 }],
      ["gpt-4.1-mini", { input: 0, output: 0, cacheRead: 0 }],
    ]);
  });

  it("books a load end to end on the freight example: verify the carrier, then book", async () => {
    const usage = { prompt_tokens: 900, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 800 } };
    const requests = stubEndpoint([
      completion({ tool_calls: [{ id: "v1", type: "function", function: { name: "verify_carrier", arguments: '{"mc_number":"100101"}' } }] }, "tool_calls", usage),
      completion(
        { tool_calls: [{ id: "s1", type: "function", function: { name: "search_loads", arguments: '{"origin":"Dallas","destination":"Atlanta","equipment":"dry_van"}' } }] },
        "tool_calls",
        usage,
      ),
      say("You're all set. L-1001 Dallas to Atlanta picks up Nov 4 and pays $2,100 all-in. Want it?", usage),
      completion(
        { tool_calls: [{ id: "b1", type: "function", function: { name: "book_load", arguments: '{"load_id":"L-1001","mc_number":"100101","rate":2100}' } }] },
        "tool_calls",
        usage,
      ),
      say("Booked: L-1001 at $2,100. Confirmation bookings-1.", usage),
      say("Thanks for calling. Drive safe.", usage),
    ]);
    const r = await runSuite({
      domain: await loadDomain(example),
      agent: openaiCompatAgent({ baseUrl: BASE, model: "llama3.1:8b" }),
      user: scriptedUser(),
      taskIds: ["book-at-posted-rate"],
    });

    expect(r.agent).toBe("openai:llama3.1:8b");
    expect(r.passHat["1"]).toBe(1);
    const trial = r.tasks[0]!.trials[0]!;
    expect(trial.violations).toEqual([]);
    expect(trial.events.filter((e) => e.type === "tool")).toMatchObject([
      { name: "verify_carrier", ok: true },
      { name: "search_loads", ok: true },
      { name: "book_load", ok: true },
    ]);
    expect(trial.changes.some((c) => c.table === "bookings")).toBe(true);

    // The world's answers reach the model: the booking request carries the verified carrier.
    const booking = requests[3]!.body.messages;
    expect(booking.find((m) => m.role === "tool" && m.tool_call_id === "v1")?.content).toContain("Blue Mesa Trucking");
    expect(booking.at(-1)).toEqual({ role: "user", content: "Sounds good, book it at that rate." });

    expect(trial.usage.agent["llama3.1:8b"]).toEqual({ calls: 6, input: 600, output: 240, cacheRead: 4800, cacheWrite: 0 });
    expect(trial.usage.costUsd).toBeNull(); // no list price for a self-hosted model: shown as n/a
  });
});

describe("openaiCompatUser", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("plays the caller from its hidden goal and stops on the stop token", async () => {
    const requests = stubEndpoint([say("Hi, Dana from Blue Mesa, MC 100101."), say("Thanks, bye. ###STOP###")]);
    const domain = await loadDomain(example);
    const task = domain.tasks.find((t) => t.id === "book-at-posted-rate")!;
    const models: string[] = [];
    const user = openaiCompatUser({ baseUrl: BASE, model: "gpt-test", temperature: 1 });
    expect(user.name).toBe("openai:gpt-test");

    const sim = await user.createSession({ domain, task, recordUsage: (m) => models.push(m) });
    expect(await sim.next(null)).toEqual({ text: "Hi, Dana from Blue Mesa, MC 100101.", stop: false });
    expect(await sim.next("Booked, confirmation bookings-1.")).toEqual({ text: "Thanks, bye.", stop: true });

    const [system, ...rest] = requests[1]!.body.messages;
    expect(system!.role).toBe("system");
    expect(system!.content).toContain("You are Dana, dispatcher at Blue Mesa Trucking");
    expect(rest).toEqual([
      { role: "user", content: USER_KICKOFF },
      { role: "assistant", content: "Hi, Dana from Blue Mesa, MC 100101." },
      { role: "user", content: "Booked, confirmation bookings-1." },
    ]);
    expect(requests[0]!.body).not.toHaveProperty("tools");
    expect(requests[0]!.body.temperature).toBe(1);
    expect(models).toEqual(["gpt-test", "gpt-test"]);
  });
});

describe("retries", () => {
  it("retries 429 and 5xx with backoff, honouring Retry-After, then succeeds", async () => {
    const { openaiCompatAgent, backoffMs } = await import("../src/sim/openai-compat.ts");
    expect(backoffMs(0, "2")).toBe(2000);
    expect(backoffMs(3)).toBeLessThanOrEqual(5000);
    const statuses = [429, 503];
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      const status = statuses.shift();
      if (status) return new Response("busy", { status, headers: { "retry-after": "0" } });
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] }), { status: 200 });
    });
    const session = await openaiCompatAgent({ baseUrl: "http://x/v1", model: "m" }).createSession({
      domain: undefined as never,
      system: "s",
      tools: [],
      sessionId: "t",
    });
    expect(await session.reply("hello", async () => ({ ok: true }))).toBe("hi");
    expect(calls).toBe(3);
    vi.unstubAllGlobals();
  });

  it("gives up after maxRetries and surfaces the status", async () => {
    const { openaiCompatAgent } = await import("../src/sim/openai-compat.ts");
    vi.stubGlobal("fetch", async () => new Response("down", { status: 500, headers: { "retry-after": "0" } }));
    const session = await openaiCompatAgent({ baseUrl: "http://x/v1", model: "m", maxRetries: 1 }).createSession({
      domain: undefined as never,
      system: "s",
      tools: [],
      sessionId: "t",
    });
    await expect(session.reply("hello", async () => ({ ok: true }))).rejects.toThrow(/returned 500/);
    vi.unstubAllGlobals();
  });
});
