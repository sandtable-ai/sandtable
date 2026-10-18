import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSuite } from "../src/run/suite.ts";
import { claudeAgent, claudeUser } from "../src/sim/claude.ts";
import { httpAgent } from "../src/sim/http.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import { loadDomain } from "../src/spec/load.ts";

const example = path.resolve("examples/freight");

/** Minimal stand-in for the SDK client: replays canned responses and records requests. */
function fakeClient(responses: Array<{ stop_reason: string; content: unknown[] }>) {
  const requests: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        create: async (req: Record<string, unknown>) => {
          requests.push(structuredClone(req));
          const next = responses.shift();
          if (!next) throw new Error("no more fake responses");
          return next;
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, requests };
}

describe("claudeAgent", () => {
  it("runs the tool loop against the world and returns the final text", async () => {
    const { client, requests } = fakeClient([
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "verify_carrier", input: { mc_number: "100101" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "You're verified. Which lane?" }] },
    ]);
    const r = await runSuite({
      domain: await loadDomain(example),
      agent: claudeAgent({ client }),
      user: scriptedUser(),
      taskIds: ["payment-question-handoff"],
    });
    const events = r.tasks[0]!.trials[0]!.events;
    expect(events.find((e) => e.type === "tool")).toMatchObject({ name: "verify_carrier", ok: true });
    expect(events.find((e) => e.type === "agent")).toMatchObject({ text: "You're verified. Which lane?" });

    // Second request carries the tool result back, after the untouched assistant turn.
    const second = requests[1] as { messages: Array<{ role: string; content: unknown }>; model: string; fallbacks?: string };
    expect(second.model).toBe("claude-opus-5-5");
    expect(second.fallbacks).toBe("default");
    expect(second.messages.at(-1)).toMatchObject({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] });
  });

  it("does not request fallbacks for models without them", async () => {
    const { client, requests } = fakeClient([{ stop_reason: "end_turn", content: [{ type: "text", text: "hi" }] }]);
    const domain = await loadDomain(example);
    const session = await claudeAgent({ client, model: "claude-haiku-5-5" }).createSession({ domain, system: "s", tools: [], sessionId: "x" });
    await session.reply("hello", async () => ({ ok: true }));
    expect(requests[0]).not.toHaveProperty("fallbacks");
  });
});

describe("claudeUser", () => {
  it("strips the stop token and reports stop", async () => {
    const { client } = fakeClient([
      { stop_reason: "end_turn", content: [{ type: "text", text: "Hi, MC 100101 here." }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Thanks, bye. ###STOP###" }] },
    ]);
    const domain = await loadDomain(example);
    const sim = await claudeUser({ client }).createSession({ domain, task: domain.tasks[0]! });
    expect(await sim.next(null)).toEqual({ text: "Hi, MC 100101 here.", stop: false });
    expect(await sim.next("Booked!")).toEqual({ text: "Thanks, bye.", stop: true });
  });
});

describe("httpAgent", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("executes tool_calls from the endpoint and posts results back", async () => {
    const bodies: Record<string, unknown>[] = [];
    const replies = [
      { tool_calls: [{ id: "c1", name: "get_load", arguments: { load_id: "L-1001" } }] },
      { reply: "L-1001 pays $2100." },
    ];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify(replies.shift()), { status: 200 });
    });
    const domain = await loadDomain(example);
    const session = await httpAgent("http://agent.local/step").createSession({ domain, system: "s", tools: [], sessionId: "t#0" });
    const calls: string[] = [];
    const text = await session.reply("L-1001?", async (name) => {
      calls.push(name);
      return { ok: true, result: { posted_rate: 2100 } };
    });
    expect(text).toBe("L-1001 pays $2100.");
    expect(calls).toEqual(["get_load"]);
    expect(bodies[1]).toMatchObject({ session_id: "t#0", tool_results: [{ id: "c1", ok: true, result: { posted_rate: 2100 } }] });
  });
});
