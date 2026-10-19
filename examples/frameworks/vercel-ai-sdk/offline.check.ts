/**
 * Offline check: no model calls, no API key. The AI SDK's MockLanguageModelV4 replays a scripted
 * conversation, and sandtable runs one freight task through the adapter with the scripted caller.
 *
 *   npm run check
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MockLanguageModelV4 } from "ai/test";
import { loadDomain, runSuite, scriptedUser, toolSchema } from "sandtable-ai";
import vercelAiSdkAgent from "./agent.ts";

const freight = fileURLToPath(new URL("../../freight", import.meta.url));

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};
const call = (id: string, toolName: string, input: object) => ({
  content: [{ type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage,
  warnings: [],
});
const say = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage,
  warnings: [],
});

test("a scripted model books L-1001 through callTool, and the trial passes", async () => {
  // One model response per step, across the three turns of task book-at-posted-rate.
  const model = new MockLanguageModelV4({
    doGenerate: [
      call("c1", "verify_carrier", { mc_number: "100101" }),
      call("c2", "search_loads", { origin: "Dallas", destination: "Atlanta", equipment: "dry_van" }),
      say("L-1001, Dallas to Atlanta, picks up Nov 4, posted at $2,100. Want it?"),
      call("c3", "book_load", { load_id: "L-1001", mc_number: "100101", rate: 2100 }),
      say("You're booked on L-1001 at $2,100."),
      say("Thanks for calling."),
    ],
  });
  const domain = await loadDomain(freight);
  const result = await runSuite({ domain, agent: vercelAiSdkAgent({ model }), user: scriptedUser(), taskIds: ["book-at-posted-rate"] });

  const [trial] = result.tasks[0]!.trials;
  assert.equal(trial!.error, undefined);
  const tools = trial!.events.filter((e) => e.type === "tool");
  assert.deepEqual(
    tools.map((e) => [e.name, e.ok]),
    [["verify_carrier", true], ["search_loads", true], ["book_load", true]],
  );
  assert.equal(trial!.passed, true, JSON.stringify(trial!.checks));
  assert.equal(result.passHat["1"], 1);

  // History is kept per session: the last model call still sees turn 1's user message, tool result and reply.
  assert.equal(model.doGenerateCalls.length, 6);
  const lastPrompt = JSON.stringify(model.doGenerateCalls[5]!.prompt);
  assert.match(lastPrompt, /Got anything Dallas to Atlanta/);
  assert.match(lastPrompt, /safety_rating/);
  assert.match(lastPrompt, /Want it\?/);
  // Token usage reaches sandtable's report.
  assert.equal(result.usage.agent["mock-model-id"]?.calls, 6);
});

test("a failed tool call goes back to the model as a tool error", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [call("c1", "verify_carrier", { mc_number: "999999" }), say("I couldn't find that MC number.")],
  });
  const domain = await loadDomain(freight);
  const session = await vercelAiSdkAgent({ model }).createSession({
    domain,
    system: "You are a freight broker's carrier sales agent.",
    tools: domain.tools.map(toolSchema),
    sessionId: "offline-check#0",
  });
  const calls: unknown[] = [];
  const reply = await session.reply("MC 999999, anything out of Dallas?", async (name, args) => {
    calls.push([name, args]);
    return { ok: false, error: "carriers 999999 not found" };
  });

  assert.deepEqual(calls, [["verify_carrier", { mc_number: "999999" }]]);
  assert.match(JSON.stringify(model.doGenerateCalls[1]!.prompt), /carriers 999999 not found/);
  assert.equal(reply, "I couldn't find that MC number.");
});
