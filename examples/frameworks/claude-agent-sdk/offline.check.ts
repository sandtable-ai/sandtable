/**
 * Offline check: no model calls, no API key, and no Claude Code process.
 *
 * The Claude Agent SDK runs its agent loop inside the Claude Code process it spawns, so this check
 * can't drive a conversation without a model. It checks what it can without one: the module loads
 * and exports an adapter, and the in-process MCP server exposes the domain's tools and routes each
 * call into sandtable's simulated world. The query loop and the per-session history are not checked.
 *
 *   npm run check
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { coerceArgs, executeTool, loadDomain, toolSchema, World, type CallTool } from "sandtable-ai";
import claudeAgentSdkAgent, { worldServer } from "./agent.ts";

const freight = fileURLToPath(new URL("../../freight", import.meta.url));

test("the module default-exports an AgentAdapter factory", () => {
  const agent = claudeAgentSdkAgent();
  assert.equal(agent.name, "claude-agent-sdk");
  assert.equal(typeof agent.createSession, "function");
});

test("the MCP server exposes the domain's tools and runs them in the simulated world", async () => {
  const domain = await loadDomain(freight);
  const world = new World(domain.world);
  // The same steps sandtable takes for each call, minus the invariant checks: validate, then execute.
  const callTool: CallTool = async (name, args) => {
    const t = domain.tools.find((x) => x.name === name)!;
    const coerced = coerceArgs(t, args);
    return "error" in coerced ? { ok: false, error: coerced.error } : executeTool(t, world, coerced.args);
  };

  const server = worldServer(domain.tools.map(toolSchema), callTool);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: "offline-check", version: "1.0.0" });
  await client.connect(clientSide);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), domain.tools.map((t) => t.name).sort());
  const search = tools.find((t) => t.name === "search_loads")!;
  assert.deepEqual(search.inputSchema.required, ["origin"]);
  assert.deepEqual(Object.keys(search.inputSchema.properties ?? {}).sort(), ["destination", "equipment", "origin", "pickup_from", "pickup_to"]);

  const verified = await client.callTool({ name: "verify_carrier", arguments: { mc_number: "100101" } });
  assert.equal(verified.isError, undefined);
  assert.match(JSON.stringify(verified.content), /Blue Mesa Trucking/);

  const booked = await client.callTool({ name: "book_load", arguments: { load_id: "L-1001", mc_number: "100101", rate: 2100 } });
  assert.equal(booked.isError, undefined);
  assert.equal(world.list("bookings", { load_id: "L-1001" }).length, 1);
  assert.equal(world.get("loads", "L-1001")?.status, "booked");

  const refused = await client.callTool({ name: "book_load", arguments: { load_id: "L-1003", mc_number: "100101", rate: 950 } });
  assert.equal(refused.isError, true);
  assert.match(JSON.stringify(refused.content), /Load L-1003 is not available/);

  await client.close();
});
