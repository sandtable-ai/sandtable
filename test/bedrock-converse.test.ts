import path from "node:path";
import { describe, expect, it } from "vitest";
import { runSuite } from "../src/run/suite.ts";
import { bedrockConverseAgent, type ConverseClient } from "../src/sim/bedrock-converse.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import { loadDomain } from "../src/spec/load.ts";

const example = path.resolve("examples/freight");

type Req = { modelId: string; messages: Array<{ role: string; content: Array<Record<string, unknown>> }>; toolConfig?: { tools: unknown[] } };

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
    expect(requests[0]!.toolConfig!.tools).toHaveLength(domain.tools.length);
    const last = requests[2]!.messages;
    expect(last.at(-1)).toMatchObject({ role: "user", content: [{ toolResult: { toolUseId: "t2", status: "error" } }] });
    expect(last[2]).toMatchObject({ role: "user", content: [{ toolResult: { toolUseId: "t1", status: "success" } }] });
    expect(usage).toHaveLength(3);
    expect(usage[0]).toEqual(["global.openai.gpt-5.5", { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }]);
  });

  it("reports filtered output instead of an empty reply", async () => {
    const { client } = stub([{ stopReason: "content_filtered", output: { message: { role: "assistant", content: [] } } }]);
    const domain = await loadDomain(example);
    const session = await bedrockConverseAgent({ modelId: "m", client }).createSession({ domain, system: "s", tools: [], sessionId: "x" });
    expect(await session.reply("hi", async () => ({ ok: true }))).toBe("[agent output was filtered]");
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
