/**
 * Offline check: no model calls, no API key. The SDK's ScriptedModel replays a scripted
 * conversation, and sandtable runs one freight task through the adapter with the scripted caller.
 *
 *   npm run check
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { setTracingDisabled } from "@openai/agents";
import { assistantMessage, functionCall, ScriptedModel } from "@openai/agents/testing";
import { loadDomain, runSuite, scriptedUser, toolSchema } from "sandtable-ai";
import openaiAgentsAgent from "./agent.ts";

setTracingDisabled(true);
const freight = fileURLToPath(new URL("../../freight", import.meta.url));

test("a scripted model books L-1001 through callTool, and the trial passes", async () => {
  // One model response per step, across the three turns of task book-at-posted-rate.
  const model = new ScriptedModel([
    [functionCall("verify_carrier", { mc_number: "100101" }, { callId: "c1" })],
    [functionCall("search_loads", { origin: "Dallas", destination: "Atlanta", equipment: "dry_van", pickup_from: null, pickup_to: null }, { callId: "c2" })],
    [assistantMessage("L-1001, Dallas to Atlanta, picks up Nov 4, posted at $2,100. Want it?")],
    [functionCall("book_load", { load_id: "L-1001", mc_number: "100101", rate: 2100 }, { callId: "c3" })],
    [assistantMessage("You're booked on L-1001 at $2,100.")],
    [assistantMessage("Thanks for calling.")],
  ]);
  const domain = await loadDomain(freight);
  const result = await runSuite({ domain, agent: openaiAgentsAgent({ model }), user: scriptedUser(), taskIds: ["book-at-posted-rate"] });

  const [trial] = result.tasks[0]!.trials;
  assert.equal(trial!.error, undefined);
  const tools = trial!.events.filter((e) => e.type === "tool");
  assert.deepEqual(
    tools.map((e) => [e.name, e.ok]),
    [["verify_carrier", true], ["search_loads", true], ["book_load", true]],
  );
  // Strict mode sends optional params as nullable; the nulls never reach the simulated world.
  assert.deepEqual(tools[1]!.args, { origin: "Dallas", destination: "Atlanta", equipment: "dry_van" });
  assert.equal(trial!.passed, true, JSON.stringify(trial!.checks));
  assert.equal(result.passHat["1"], 1);

  // History is kept per session: the last model call still sees turn 1's user message, tool result and reply.
  model.assertComplete();
  const lastInput = JSON.stringify(model.lastCall!.request.input);
  assert.match(lastInput, /Got anything Dallas to Atlanta/);
  assert.match(lastInput, /safety_rating/);
  assert.match(lastInput, /Want it\?/);
});

test("a failed tool call goes back to the model with its error", async () => {
  const model = new ScriptedModel([
    [functionCall("verify_carrier", { mc_number: "999999" }, { callId: "c1" })],
    [assistantMessage("I couldn't find that MC number.")],
  ]);
  const domain = await loadDomain(freight);
  const session = await openaiAgentsAgent({ model }).createSession({
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
  assert.match(JSON.stringify(model.lastCall!.request.input), /carriers 999999 not found/);
  assert.equal(reply, "I couldn't find that MC number.");
});
