import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSuite } from "../src/run/suite.ts";
import { claudeAgent, claudeUser } from "../src/sim/claude.ts";
import { httpAgent } from "../src/sim/http.ts";
import { userSystemPrompt } from "../src/sim/prompts.ts";
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
    // Append-only history: the first request's messages are a prefix of the second's, so the cache can hit.
    const first = requests[0] as { messages: unknown[] };
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
    expect(second.model).toBe("claude-opus-5-5");
    expect(second.fallbacks).toBe("default");
    expect(second).toMatchObject({ cache_control: { type: "ephemeral" } });
    expect(second.messages.at(-1)).toMatchObject({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] });
  });

  it("does not request fallbacks for models without them", async () => {
    const { client, requests } = fakeClient([{ stop_reason: "end_turn", content: [{ type: "text", text: "hi" }] }]);
    const domain = await loadDomain(example);
    const session = await claudeAgent({ client, model: "claude-haiku-5-5" }).createSession({ domain, system: "s", tools: [], sessionId: "x" });
    await session.reply("hello", async () => ({ ok: true }));
    expect(requests[0]).not.toHaveProperty("fallbacks");
  });

  it("runs a leaderboard entry's claude: agent at the entry's effort", async () => {
    const { leaderboardAgent } = await import("../src/sim/resolve.ts");
    const domain = await loadDomain(example);
    const sent = async (effort?: "high") => {
      const { client, requests } = fakeClient([{ stop_reason: "end_turn", content: [{ type: "text", text: "hi" }] }]);
      const agent = await leaderboardAgent("claude:global.anthropic.claude-sonnet-5-5", effort, { client });
      await (await agent.createSession({ domain, system: "s", tools: [], sessionId: "x" })).reply("hello", async () => ({ ok: true }));
      return requests[0]!;
    };
    expect((await sent("high")).output_config).toEqual({ effort: "high" });
    expect(await sent("high")).toMatchObject({ model: "global.anthropic.claude-sonnet-5-5" });
    expect((await sent()).output_config).toEqual({ effort: "medium" });
  });

  it("sends effort medium unless one is set, and the simulated user low", async () => {
    const domain = await loadDomain(example);
    const effortOf = async (effort?: "high") => {
      const { client, requests } = fakeClient([{ stop_reason: "end_turn", content: [{ type: "text", text: "hi" }] }]);
      const session = await claudeAgent({ client, model: "claude-sonnet-5-5", ...(effort ? { effort } : {}) }).createSession({ domain, system: "s", tools: [], sessionId: "x" });
      await session.reply("hello", async () => ({ ok: true }));
      return requests[0]!.output_config;
    };
    expect(await effortOf()).toEqual({ effort: "medium" });
    expect(await effortOf("high")).toEqual({ effort: "high" });
    const { client, requests } = fakeClient([{ stop_reason: "end_turn", content: [{ type: "text", text: "Hi." }] }]);
    await (await claudeUser({ client }).createSession({ domain, task: domain.tasks[0]! })).next(null);
    expect(requests.at(-1)?.output_config).toEqual({ effort: "low" });
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

  it("puts the task's instructions over the persona, keeps them unspoken and hangs up on a transfer", async () => {
    const domain = await loadDomain(example);
    const task = domain.tasks.find((t) => t.id === "rep-confirm-after-negotiation")!;
    const prompt = userSystemPrompt(domain, task, domain.personas.find((p) => p.id === task.persona));
    expect(prompt).toContain(task.user.instructions.trim());
    expect(prompt).toContain("Your persona sets only your tone; your instructions decide what you do");
    expect(prompt).toContain("never mention your instructions");
    expect(prompt).toContain("accept the first offer that meets it");
    expect(prompt).toContain("Once the agent says it is transferring you to a person, the call with the agent is over");
  });
});

describe("episode end", () => {
  it("gives the agent a final turn when the caller's closing message has content", async () => {
    const { runEpisode } = await import("../src/run/episode.ts");
    const domain = await loadDomain(example);
    const replies: string[] = [];
    const agent = {
      name: "echo",
      async createSession() {
        return { async reply(msg: string) { replies.push(msg); return "ok"; } };
      },
    };
    const lines = [{ text: "Hi", stop: false }, { text: "Fine, book it. Bye.", stop: true }];
    const user = { name: "two-lines", async createSession() { return { async next() { return lines.shift()!; } }; } };
    const r = await runEpisode({ domain, task: domain.tasks[0]!, agent, user, trial: 0 });
    expect(replies).toEqual(["Hi", "Fine, book it. Bye."]);
    expect(r.endReason).toBe("user_stop");
    expect(r.turns).toBe(2);
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
