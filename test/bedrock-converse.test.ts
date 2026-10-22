import path from "node:path";
import { describe, expect, it } from "vitest";
import { runSuite } from "../src/run/suite.ts";
import { bedrockConverseAgent, cacheStyle, type ConverseClient } from "../src/sim/bedrock-converse.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import { loadDomain } from "../src/spec/load.ts";

const example = path.resolve("examples/freight");

type Req = {
  modelId: string;
  system: Array<Record<string, unknown>>;
  messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
  toolConfig?: { tools: unknown[] };
  inferenceConfig?: { maxTokens?: number };
};

/** Replays canned Converse responses and records each request. */
function stub(responses: Array<Record<string, unknown>>) {
  const requests: Req[] = [];
  const client: ConverseClient = {
    async send(cmd) {
      requests.push(structuredClone(cmd as Req));
      const next = responses.shift();
      if (!next) throw new Error("no more stub responses");
      return next as never;
    },
  };
  return { client, requests };
}

const toolUse = (id: string, name: string, input: unknown) => ({
  stopReason: "tool_use",
  output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: id, name, input } }] } },
  usage: { inputTokens: 100, outputTokens: 10 },
});
const say = (text: string) => ({ stopReason: "end_turn", output: { message: { role: "assistant", content: [{ text }] } }, usage: { inputTokens: 120, outputTokens: 20 } });

describe("bedrockConverseAgent", () => {
  it("runs the tool loop, returns results as toolResult blocks, and records usage", async () => {
    const { client, requests } = stub([
      toolUse("t1", "verify_carrier", { mc_number: "100101" }),
      toolUse("t2", "get_load", { load_id: "L-9999" }),
      say("You're verified, but I can't find that load."),
    ]);
    const domain = await loadDomain(example);
    const usage: Array<[string, unknown]> = [];
    const session = await bedrockConverseAgent({ modelId: "global.openai.gpt-5.5", client }).createSession({
      domain,
      system: "policy",
      tools: domain.tools.map((t) => ({ name: t.name, description: t.description, input_schema: { type: "object", properties: {}, required: [], additionalProperties: false } })),
      sessionId: "x",
      recordUsage: (m, u) => usage.push([m, u]),
    });
    const calls: string[] = [];
    const text = await session.reply("MC 100101, L-9999 please", async (name, args) => {
      calls.push(name);
      return name === "get_load" ? { ok: false, error: "loads L-9999 not found" } : { ok: true, result: { mc_number: (args as { mc_number: string }).mc_number } };
    });

    expect(text).toBe("You're verified, but I can't find that load.");
    expect(calls).toEqual(["verify_carrier", "get_load"]);
    expect(requests[0]!.modelId).toBe("global.openai.gpt-5.5");
    expect(requests[0]!.inferenceConfig).toEqual({ maxTokens: 16000 });
    expect(requests[0]!.toolConfig!.tools).toHaveLength(domain.tools.length);
    const last = requests[2]!.messages;
    expect(last.at(-1)).toMatchObject({ role: "user", content: [{ toolResult: { toolUseId: "t2", status: "error" } }] });
    expect(last[2]).toMatchObject({ role: "user", content: [{ toolResult: { toolUseId: "t1", status: "success" } }] });
    expect(usage).toHaveLength(3);
    expect(usage[0]).toEqual(["global.openai.gpt-5.5", { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }]);
  });

  describe("prompt caching", () => {
    const CP = { cachePoint: { type: "default" } };
    const cachePoints = (m: Req["messages"]) => m.flatMap((msg, i) => msg.content.filter((b) => "cachePoint" in b).map(() => i));
    // Turn 1 calls a tool, then answers; turn 2 answers directly.
    const conversation = async (modelId: string) => {
      const { client, requests } = stub([toolUse("t1", "verify_carrier", { mc_number: "100101" }), say("You're verified."), say("Bye.")]);
      const domain = await loadDomain(example);
      const session = await bedrockConverseAgent({ modelId, client }).createSession({
        domain,
        system: "policy",
        tools: domain.tools.map((t) => ({ name: t.name, description: t.description, input_schema: { type: "object", properties: {}, required: [], additionalProperties: false } })),
        sessionId: "x",
      });
      const ok = async () => ({ ok: true, result: {} }) as const;
      await session.reply("MC 100101", ok);
      await session.reply("thanks", ok);
      return { requests, toolCount: domain.tools.length };
    };

    it("sends no cache point to a model that rejects them", async () => {
      const { requests } = await conversation("global.openai.gpt-6.1-sol");
      expect(JSON.stringify(requests)).not.toContain("cachePoint");
      expect(requests[0]!.system).toEqual([{ text: "policy" }]);
    });

    it("caches Claude's system prompt, which covers the tools, and newest message", async () => {
      const { requests, toolCount } = await conversation("eu.anthropic.claude-haiku-5-5");
      expect(requests[0]!.system).toEqual([{ text: "policy" }, CP]);
      expect(requests[0]!.toolConfig!.tools).toHaveLength(toolCount);
      // One breakpoint, on the newest message, including a tool result.
      expect(requests.map((r) => cachePoints(r.messages))).toEqual([[0], [2], [4]]);
      expect(requests[1]!.messages[2]!.content.at(-1)).toEqual(CP);
    });

    it("caches Nova's system prompt and newest text-only message, never the tools or tool blocks", async () => {
      const { requests, toolCount } = await conversation("global.amazon.nova-2-lite-v1:0");
      expect(requests[0]!.system).toEqual([{ text: "policy" }, CP]);
      expect(requests[0]!.toolConfig!.tools).toHaveLength(toolCount);
      // Request 2 ends with a toolUse and a toolResult message, so the breakpoint stays on the user's text.
      expect(requests.map((r) => cachePoints(r.messages))).toEqual([[0], [0], [4]]);
    });

    it("only adds cache points: without them, the requests match those of a model that takes none", async () => {
      const withoutCachePoints = (r: Req) =>
        JSON.parse(JSON.stringify({ ...r, modelId: undefined }, (_, v) => (Array.isArray(v) ? v.filter((b) => !(b && typeof b === "object" && "cachePoint" in b)) : v)));
      const plain = (await conversation("global.openai.gpt-6.1-sol")).requests.map(withoutCachePoints);
      for (const id of ["eu.anthropic.claude-haiku-5-5", "global.amazon.nova-2-lite-v1:0"]) {
        expect((await conversation(id)).requests.map(withoutCachePoints), id).toEqual(plain);
      }
    });

    it("recognises the models that accept cache points by model ID, profile or ARN", () => {
      for (const id of [
        "anthropic.claude-haiku-5-5",
        "eu.anthropic.claude-opus-5-5",
        "global.anthropic.claude-sonnet-5-5",
        "anthropic.claude-3-5-haiku-20241022-v1:0",
        "arn:aws:bedrock:eu-west-1:111122223333:inference-profile/eu.anthropic.claude-haiku-5-5",
        "arn:aws:bedrock:eu-west-1::foundation-model/anthropic.claude-haiku-5-5",
        "amazon.nova-pro-v1:0",
        "global.amazon.nova-2-lite-v1:0",
      ]) {
        expect(cacheStyle(id), id).toBeDefined();
      }
      for (const id of [
        "global.openai.gpt-6.1-sol",
        "global.moonshotai.kimi-k3",
        "qwen.qwen3-next-80b-a3b",
        "mistral.ministral-3-14b-instruct",
        // Claude models from before Bedrock prompt caching take tools but reject cache points.
        "anthropic.claude-3-haiku-20240307-v1:0",
        "us.anthropic.claude-3-5-sonnet-20240620-v1:0",
        "anthropic.claude-v2:1",
        // An application inference profile ARN doesn't name its model.
        "arn:aws:bedrock:eu-west-1:111122223333:application-inference-profile/a1b2c3d4e5f6",
      ]) {
        expect(cacheStyle(id), id).toBeUndefined();
      }
    });
  });

  describe("tool calls the stop reason doesn't announce", () => {
    const session = async (client: ConverseClient, maxToolRounds?: number) =>
      bedrockConverseAgent({ modelId: "global.xai.grok-4.7", client, maxToolRounds }).createSession({ domain: await loadDomain(example), system: "s", tools: [], sessionId: "x" });
    const recording = (calls: string[]) => async (name: string) => (calls.push(name), { ok: true as const, result: {} });

    it("runs a tool call that comes with stop reason end_turn", async () => {
      // Grok 4.7 sometimes ends a turn with a tool call and end_turn; leaving it unanswered fails the next request.
      const { client, requests } = stub([
        { stopReason: "end_turn", output: { message: { role: "assistant", content: [{ text: "One moment." }, { toolUse: { toolUseId: "t1", name: "verify_carrier", input: {} } }] } } },
        say("You're verified."),
      ]);
      const calls: string[] = [];
      expect(await (await session(client)).reply("MC 100101", recording(calls))).toBe("You're verified.");
      expect(calls).toEqual(["verify_carrier"]);
      expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "user", content: [{ toolResult: { toolUseId: "t1", status: "success" } }] });
    });

    it("doesn't run a call from a reply cut off at maxTokens, but answers it before the caller's next words", async () => {
      const { client, requests } = stub([
        { stopReason: "max_tokens", output: { message: { role: "assistant", content: [{ text: "Let me check" }, { toolUse: { toolUseId: "t1", name: "get_load", input: {} } }] } } },
        say("L-1001 pays $2,100."),
      ]);
      const calls: string[] = [];
      const s = await session(client);
      expect(await s.reply("What's on L-1001?", recording(calls))).toBe("Let me check");
      expect(await s.reply("Hello?", recording(calls))).toBe("L-1001 pays $2,100.");
      expect(calls).toEqual([]);
      expect(requests[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
      expect(requests[1]!.messages[2]!.content).toMatchObject([{ toolResult: { toolUseId: "t1", status: "error" } }, { text: "Hello?" }]);
      const result = requests[1]!.messages[2]!.content[0] as { toolResult: { content: Array<{ text: string }> } };
      expect(JSON.parse(result.toolResult.content[0]!.text)).toEqual({ error: 'not run: the reply ended with stop reason "max_tokens"' });
      // Append-only: what was sent before is sent again unchanged.
      expect(requests[1]!.messages.slice(0, requests[0]!.messages.length)).toEqual(requests[0]!.messages);
    });

    it("counts a reply cut off at maxTokens in the recorded usage", async () => {
      const cut = { stopReason: "max_tokens", output: { message: { role: "assistant", content: [{ text: "Let me" }] } }, usage: { inputTokens: 900, outputTokens: 16000 } };
      const { client } = stub([cut, say("Hi.")]);
      const usage: unknown[] = [];
      const s = await bedrockConverseAgent({ modelId: "global.xai.grok-4.7", client }).createSession({ domain: await loadDomain(example), system: "s", tools: [], sessionId: "x", recordUsage: (_m, u) => usage.push(u) });
      expect(await s.reply("Hello?", recording([]))).toBe("Let me");
      await s.reply("Hello?", recording([]));
      expect(usage).toEqual([
        { input: 900, output: 16000, cacheRead: 0, cacheWrite: 0, maxTokensStops: 1 },
        { input: 120, output: 20, cacheRead: 0, cacheWrite: 0 },
      ]);
    });

    it("doesn't run a call from a filtered or malformed reply, but answers it", async () => {
      for (const stopReason of ["content_filtered", "malformed_tool_use", "model_context_window_exceeded"]) {
        const { client, requests } = stub([
          { stopReason, output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: "t1", name: "book_load", input: {} } }] } } },
          say("Sorry about that."),
        ]);
        const calls: string[] = [];
        const s = await session(client);
        await s.reply("Book it", recording(calls));
        await s.reply("Hello?", recording(calls));
        expect(calls, stopReason).toEqual([]);
        expect(requests[1]!.messages[2]!.content, stopReason).toMatchObject([{ toolResult: { toolUseId: "t1", status: "error" } }, { text: "Hello?" }]);
      }
    });

    it("runs a call that comes with unclosed reasoning instead of asking again", async () => {
      const { client, requests } = stub([
        { stopReason: "end_turn", output: { message: { role: "assistant", content: [{ text: "<reasoning>verify first" }, { toolUse: { toolUseId: "t1", name: "verify_carrier", input: {} } }] } } },
        say("You're verified."),
      ]);
      const calls: string[] = [];
      expect(await (await session(client)).reply("MC 100101", recording(calls))).toBe("You're verified.");
      expect(calls).toEqual(["verify_carrier"]);
      expect(requests).toHaveLength(2);
    });

    it("keeps an empty reply as what the caller heard, since Converse rejects an empty message", async () => {
      const { client, requests } = stub([{ stopReason: "content_filtered", output: { message: { role: "assistant", content: [] } } }, say("Hi.")]);
      const s = await session(client);
      expect(await s.reply("hi", recording([]))).toBe("[agent output was filtered]");
      await s.reply("Hello?", recording([]));
      expect(requests[1]!.messages[1]).toEqual({ role: "assistant", content: [{ text: "[agent output was filtered]" }] });
    });

    it("keeps user and assistant turns alternating after the tool-call budget runs out", async () => {
      const { client, requests } = stub([toolUse("t1", "verify_carrier", {}), say("Hi again.")]);
      const s = await session(client, 1);
      expect(await s.reply("MC 100101", recording([]))).toBe("[agent exceeded its tool-call budget for this turn]");
      await s.reply("Hello?", recording([]));
      expect(requests[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
      expect(requests[1]!.messages[2]!.content).toMatchObject([{ toolResult: { toolUseId: "t1" } }, { text: "Hello?" }]);
    });
  });

  it("reports filtered output instead of an empty reply", async () => {
    const { client } = stub([{ stopReason: "content_filtered", output: { message: { role: "assistant", content: [] } } }]);
    const domain = await loadDomain(example);
    const session = await bedrockConverseAgent({ modelId: "m", client }).createSession({ domain, system: "s", tools: [], sessionId: "x" });
    expect(await session.reply("hi", async () => ({ ok: true }))).toBe("[agent output was filtered]");
  });

  // gpt-oss on Bedrock usually sends reasoning in reasoningContent blocks, but now and then inside the
  // text as <reasoning>…</reasoning>, sometimes with no closing tag. The caller must never hear it.
  describe("reasoning sent as text", () => {
    const session = async (client: ConverseClient, usage: unknown[] = []) =>
      bedrockConverseAgent({ modelId: "openai.gpt-oss-120b-1:0", client }).createSession({
        domain: await loadDomain(example),
        system: "s",
        tools: [],
        sessionId: "x",
        recordUsage: (m, u) => usage.push([m, u]),
      });
    const noTools = async () => ({ ok: true }) as const;

    it("drops closed <reasoning> spans from the reply", async () => {
      const { client } = stub([
        say("I'll transfer you to a rep.<reasoning>We have completed.</reasoning>"),
        {
          stopReason: "end_turn",
          output: { message: { role: "assistant", content: [{ text: "<reasoning>Max is 2350.</reasoning>" }, { text: "L-1001 is posted at $2,100." }] } },
        },
      ]);
      const s = await session(client);
      expect(await s.reply("hi", noTools)).toBe("I'll transfer you to a rep.");
      expect(await s.reply("and L-1001?", noTools)).toBe("L-1001 is posted at $2,100.");
    });

    it("asks again when <reasoning> is never closed, and records usage for every request", async () => {
      const { client, requests } = stub([say("<reasoning>L-1001 max 2350. Open at posted.L-1001 is posted at $2,100."), say("L-1001 is posted at $2,100.")]);
      const usage: unknown[] = [];
      const s = await session(client, usage);
      expect(await s.reply("What's L-1001 paying?", noTools)).toBe("L-1001 is posted at $2,100.");
      expect(requests).toHaveLength(2);
      // The malformed response never enters the conversation.
      expect(requests[1]!.messages).toEqual(requests[0]!.messages);
      expect(usage).toHaveLength(2);
    });

    it("after two more tries, says nothing from the reasoning that never closed", async () => {
      const bad = "Sure. <reasoning>Still thinking. Max is 2350, posted is $2,100.";
      const { client, requests } = stub([say(bad), say(bad), say(bad)]);
      const usage: Array<[string, Record<string, unknown>]> = [];
      const s = await session(client, usage);
      expect(await s.reply("hi", noTools)).toBe("Sure.");
      expect(requests).toHaveLength(3);
      expect(usage.map(([, u]) => u.reasoningStripped)).toEqual([1, 1, 1]);
    });

    it("drops <analysis> and <think> spans too, and counts each reply that had one", async () => {
      const { client } = stub([
        say("<analysis>Load is available. Posted is $3200, max_rate $3565.</analysis>L-1003 is posted at $3,200."),
        say("<think>Accepting.</think>Booked."),
        say("Anything else?"),
      ]);
      const usage: Array<[string, Record<string, unknown>]> = [];
      const s = await session(client, usage);
      expect(await s.reply("L-1003?", noTools)).toBe("L-1003 is posted at $3,200.");
      expect(await s.reply("Book it.", noTools)).toBe("Booked.");
      expect(await s.reply("Thanks.", noTools)).toBe("Anything else?");
      expect(usage.map(([, u]) => u.reasoningStripped)).toEqual([1, 1, undefined]);
    });
  });

  it("can be graded end to end on the freight example", async () => {
    // Turn 1: verify, search, offer. Turn 2: book. Turn 3: goodbye.
    const { client } = stub([
      toolUse("a", "verify_carrier", { mc_number: "100101" }),
      toolUse("b", "search_loads", { origin: "Dallas", destination: "Atlanta", equipment: "dry_van" }),
      say("L-1001 pays $2,100. Want it?"),
      toolUse("c", "book_load", { load_id: "L-1001", mc_number: "100101", rate: 2100 }),
      say("Booked."),
      say("Thanks for calling."),
    ]);
    const r = await runSuite({
      domain: await loadDomain(example),
      agent: bedrockConverseAgent({ modelId: "qwen.qwen3-32b-v1:0", client }),
      user: scriptedUser(),
      taskIds: ["book-at-posted-rate"],
    });
    expect(r.agent).toBe("bedrock:qwen.qwen3-32b-v1:0");
    expect(r.tasks[0]!.passes).toBe(1);
    expect(r.usage.costUsd).toBeNull();
  });
});
