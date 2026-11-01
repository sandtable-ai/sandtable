import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { draftFromElevenLabs, elevenLabsProblem, renderElevenLabsDraft } from "../src/init/elevenlabs.ts";
import type { PlatformFile } from "../src/init/platform.ts";
import { lintDomain } from "../src/grade/lint.ts";
import { runSuite } from "../src/run/suite.ts";
import { noopAgent } from "../src/sim/noop.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import { loadDomain, parseDomain, validateDomain } from "../src/spec/load.ts";

// sandtable import elevenlabs (#35): a draft domain from an ElevenLabs agent, its tools and its tests, as the
// ElevenLabs CLI pulls them into a project or as the API returns them.

const run = promisify(execFile);
const cli = path.resolve("src/cli.ts");
const example = path.resolve("examples/elevenlabs");

const END_CALL = { type: "system", name: "end_call", description: "", params: { system_tool_type: "end_call" } };
const elAgent = (prompt: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, agent: Record<string, unknown> = {}) => ({
  name: "Desk",
  conversation_config: { agent: { first_message: "Hi there.", prompt: { prompt: "Be helpful.", tool_ids: [], built_in_tools: { end_call: END_CALL }, ...prompt }, ...agent } },
  platform_settings: {},
  tags: [],
  ...extra,
});
const webhook = (name: string, api_schema: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: "webhook", name, description: `${name} does it`, api_schema, ...extra });
const files = (...items: [string, unknown][]): PlatformFile[] => items.map(([file, json]) => ({ file, json }));

/** The draft as the domain its files make, parsed and cross-checked as a loaded one is. */
function domainOf(f: PlatformFile[], pick?: string) {
  const d = draftFromElevenLabs(f, pick);
  const r = renderElevenLabsDraft(d);
  return { draft: d, domain: parseDomain({ ...YAML.parse(r.domain), policy: d.policy, tasks: YAML.parse(r.tasks) }) };
}

describe("import elevenlabs: the bundled example", () => {
  it.skipIf(!process.features.typescript)("imports a CLI project, validates, lints and runs with the scripted user from the CLI", { timeout: 30_000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-import-el-"));
    const out = path.join(dir, "pinecrest");
    const imported = await run(process.execPath, [cli, "import", "elevenlabs", example, "-o", out]);
    expect(imported.stdout).toContain("Imported pinecrest-bike-repair from ElevenLabs: 3 tools, 0 tables, 2 tasks, all pending review.");
    expect(imported.stdout).toContain("{{customer_phone}}");
    expect(imported.stdout).toContain("base URL");
    const domain = await loadDomain(out);
    expect(domain.tools.map((t) => [t.name, t.http])).toEqual([
      ["get_repair", { method: "GET", path: "/api/repairs/{ticket_id}" }],
      ["book_service", { method: "POST", path: "/api/bookings" }],
      ["end_call", undefined],
    ]);
    expect(domain.policy).toMatch(/^# Pinecrest Bike Repair\n\nYou are the phone assistant for Pinecrest Bike Repair/);
    expect(domain.policy).toContain('Open each call with: "Thanks for calling Pinecrest Bike Repair, this is the service desk. How can I help?"');
    expect(Object.keys(domain.tools.find((t) => t.name === "book_service")!.params)).toEqual(["customer_name", "service", "date"]);
    expect(domain.tools.find((t) => t.name === "book_service")!.ops).toEqual([{ respond: "Booked: tune-up for Riley Chen on 2026-11-12, confirmation PB-77" }]);
    const [book, lookup] = domain.tasks;
    expect(book).toMatchObject({ id: "book-a-tune-up", max_turns: 8, given: { context: { customer_phone: "+15555550142" } }, expect: { called: ["book_service"] } });
    expect(lookup).toMatchObject({
      id: "looks-up-the-ticket-before-answering",
      user: { opening: "Hi, is my bike ready? The ticket is R-2041.", script: ["Hi, is my bike ready? The ticket is R-2041."] },
      expect: { called: [{ tool: "get_repair", args: { ticket_id: "R-2041" } }] },
    });
    expect((await run(process.execPath, [cli, "validate", out])).stdout).toContain("0 tables, 3 tools, 0 invariants, 2 tasks");
    expect((await run(process.execPath, [cli, "lint", out])).stdout).toContain("0 error(s)");
    const r = await runSuite({ domain, agent: noopAgent(), user: scriptedUser() });
    expect(r.tasks.every((t) => t.passes === 0)).toBe(true);
    expect(lintDomain(domain).errors).toBe(0);
  });

  it.skipIf(!process.features.typescript)("refuses an export with no agent, two without --agent, and an unknown platform", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-import-el-bad-"));
    const fail = (...args: string[]) => run(process.execPath, [cli, ...args]).catch((e: { code: number; stderr: string }) => e);
    expect(await fail("import", "bland", example, "-o", path.join(dir, "x"))).toMatchObject({ code: 2, stderr: expect.stringContaining('unknown platform "bland": import supports vapi, retell and elevenlabs') });
    await writeFile(path.join(dir, "tool.json"), JSON.stringify(webhook("x", { url: "https://desk.example/x" })));
    expect(await fail("import", "elevenlabs", path.join(dir, "tool.json"), "-o", path.join(dir, "out"))).toMatchObject({ code: 2, stderr: expect.stringContaining("has no ElevenLabs agent") });
    await writeFile(path.join(dir, "two.json"), JSON.stringify([{ agent_id: "a1", ...elAgent({}, { name: "A" }) }, { agent_id: "b1", ...elAgent({}, { name: "B" }) }]));
    expect(await fail("import", "elevenlabs", path.join(dir, "two.json"), "-o", path.join(dir, "out"))).toMatchObject({ code: 2, stderr: expect.stringContaining("has 2 agents (A, B): pick one with --agent <name or id>") });
    expect((await run(process.execPath, [cli, "import", "elevenlabs", path.join(dir, "two.json"), "--agent", "b1", "-o", path.join(dir, "b")])).stdout).toContain("Imported b from ElevenLabs");
  });
});

describe("import elevenlabs: the files", () => {
  const project = () =>
    files(
      ["agents.json", { agents: [{ config: "agent_configs/desk.json", id: "agent_1", branches: { beta: { config: "agent_configs/desk.beta.json", branch_id: "agtbrch_beta" } } }] }],
      ["agent_configs/desk.json", elAgent({ tool_ids: ["tool_a", "tool_missing"] })],
      ["agent_configs/desk.beta.json", elAgent({ prompt: "Beta prompt.", tool_ids: ["tool_a"] })],
      ["tools.json", { tools: [{ type: "webhook", config: "tool_configs/a.json", id: "tool_a" }, { type: "webhook", config: "tool_configs/b.json", id: "tool_b" }] }],
      ["tool_configs/a.json", webhook("lookup", { url: "https://desk.example/items/{item_id}", path_params_schema: { item_id: { type: "string", description: "The item" } } })],
      ["tool_configs/b.json", webhook("unused", { url: "https://desk.example/other", method: "POST" })],
      ["tests.json", { tests: [{ config: "test_configs/t.json", type: "simulation", id: "test_1" }] }],
      ["test_configs/t.json", { id: "test_1", name: "Find it", type: "simulation", simulation_scenario: "You want item 7.", success_conditions: [] }],
      ["junk.json", { hello: 1 }],
    );

  it("resolves an agents-as-code project's agents, tools and tests through its index files", () => {
    const d = draftFromElevenLabs(project());
    expect(d.name).toBe("desk");
    expect(d.tools.map((t) => t.name)).toEqual(["lookup", "end_call"]);
    expect(d.tasks.map((t) => [t.id, t.source, t.instructions])).toEqual([["find-it", "test_configs/t.json", "You want item 7."]]);
    expect(d.warnings).toEqual([
      "junk.json: not an ElevenLabs agent (with conversation_config), tool (with tool_config, or type and name), test (with type llm, tool or simulation), or agents.json, tools.json or tests.json; skipped",
      'agent_configs/desk.beta.json: the "beta" branch of the agent "Desk"; skipped (import it with --agent beta)',
      "conversation_config.agent.prompt.tool_ids names the tool tool_missing, which no file in the export has: fetch it with `elevenlabs tools pull` (or GET https://api.elevenlabs.io/v1/convai/tools/tool_missing)",
      "tool_configs/b.json: a tool the agent doesn't use (it isn't in prompt.tool_ids or a workflow node's additional_tool_ids); skipped",
    ]);
  });

  it("imports a branch that --agent names, by its name, its id or the agent's name and its name", () => {
    for (const pick of ["beta", "agtbrch_beta", "Desk.beta"]) {
      const d = draftFromElevenLabs(project(), pick);
      expect(d.policy).toContain("Beta prompt.");
      expect(d.warnings).toContain('agent_configs/desk.json: the agent "Desk", which --agent didn\'t pick; skipped');
    }
    expect(elevenLabsProblem(project(), "gamma")).toBe('has no agent or branch named or with the id "gamma" (it has Desk, Desk.beta)');
  });

  it("says why it can't import", () => {
    expect(elevenLabsProblem(files(["t.json", webhook("x", { url: "https://desk.example/x" })]))).toMatch(/^has no ElevenLabs agent: pull the project with `elevenlabs agents pull`/);
    expect(elevenLabsProblem(files(["a.json", elAgent()]))).toBeUndefined();
    expect(elevenLabsProblem(files(["a.json", [{ agent_id: "a1", ...elAgent({}, { name: "A" }) }, { agent_id: "b1", ...elAgent({}, { name: "B" }) }]]))).toBe("has 2 agents (A, B): pick one with --agent <name or id>");
    expect(elevenLabsProblem(files(["a.json", [{ agent_id: "a1", ...elAgent({}, { name: "A" }) }, { agent_id: "b1", ...elAgent({}, { name: "B" }) }]]), "A")).toBeUndefined();
  });

  it("takes loose API responses: an agent, tools by id with their mocks, inline tools and a system transfer", () => {
    const { draft, domain } = domainOf(
      files(
        ["agent.json", { agent_id: "agent_9", ...elAgent({ tool_ids: ["t1", "t2"], tools: [{ type: "client", name: "show_map", description: "Show a map", parameters: { type: "object", properties: { city: { type: "string", description: "The city" } }, required: ["city"] } }] }) }],
        ["t1.json", { id: "t1", tool_config: webhook("get_item", { url: "https://desk.example/items/{item_id}", path_params_schema: { item_id: { type: "string", description: "The item" } } }), response_mocks: [{ mock_result: '{"item_id":"7","status":"lost"}', parameter_conditions: [] }] }],
        [
          "t2.json",
          {
            id: "t2",
            tool_config: {
              type: "system",
              name: "transfer_to_number",
              params: {
                system_tool_type: "transfer_to_number",
                transfers: [
                  { transfer_destination: { type: "phone", phone_number: "+15555550103" }, condition: "The caller wants billing" },
                  { transfer_destination: { type: "sip_uri", sip_uri: "sip:desk@desk.example" }, condition: "After hours" },
                ],
              },
            },
          },
        ],
        ["loose.json", webhook("orphan", { url: "https://desk.example/orphan" })],
        ["s.json", { id: "s1", type: "simulation", name: "Lost item", simulation_scenario: "You lost item 7.", tool_mock_config: { mocking_strategy: "all" } }],
      ),
    );
    expect(domain.tools.map((t) => t.name)).toEqual(["get_item", "transfer_to_number", "show_map", "end_call"]);
    expect(domain.tools.find((t) => t.name === "transfer_to_number")).toMatchObject({
      description: "Transfer the call to a person. Destinations: +15555550103 (The caller wants billing); sip:desk@desk.example (After hours).",
      params: { destination: { enum: ["+15555550103", "sip:desk@desk.example"] } },
    });
    expect(draft.tools.find((t) => t.name === "transfer_to_number")!.notes).toEqual(["ElevenLabs carries out a transfer itself, so with sandtable serve this tool is never called: grade a transfer there by the transcript. In a run, a transfer is a transfers row."]);
    expect(domain.tools.find((t) => t.name === "show_map")).toMatchObject({ params: { city: { type: "string", required: true } }, review: "pending" });
    expect(domain.tools.find((t) => t.name === "show_map")!.http).toBeUndefined();
    expect(draft.tools.find((t) => t.name === "show_map")!.notes[0]).toBe(
      "No test mocks it, so what it returns is unknown: model what it reads and changes with get, list, create or update ops on a table (it's a client tool, which the caller's app runs, so sandtable serve never sees a call to it).",
    );
    // The tool's own mocks apply in a test that mocks every tool.
    expect(domain.tools.find((t) => t.name === "get_item")!.ops).toEqual([{ get: "get_item_results", key: "$item_id" }]);
    expect(domain.tasks[0]!.given!.rows).toEqual({ get_item_results: [{ item_id: "7", status: "lost" }] });
    expect(draft.tables).toEqual({ transfers: { key: "transfer_id" }, get_item_results: { key: "item_id" } });
    expect(draft.warnings).toEqual(["loose.json: a tool config with no id, which no tools.json entry names, so the agent's tool_ids can't name it; skipped"]);
  });
});

describe("import elevenlabs: policy", () => {
  it("is the prompt, then each subagent node's prompt, and the first message; variable placeholders are the default context", () => {
    const workflow = {
      edges: {},
      nodes: {
        start: { type: "start" },
        billing: { type: "override_agent", label: "Billing", additional_prompt: "Handle billing for {{account}}.", additional_tool_ids: ["tool_b"] },
        n2: { type: "override_agent", label: "", additional_prompt: "Wrap up.", additional_tool_ids: [] },
      },
    };
    const { draft } = domainOf(
      files(
        ["agent.json", elAgent({}, { workflow }, { dynamic_variables: { dynamic_variable_placeholders: { account: "ACME-1" } } })],
        ["b.json", { id: "tool_b", tool_config: webhook("billing_lookup", { url: "https://desk.example/billing", method: "POST" }) }],
        ["s.json", { id: "s1", type: "simulation", name: "Pays", simulation_scenario: "Pay." }],
      ),
    );
    expect(draft.policy).toBe('# Desk\n\nBe helpful.\n\n## Billing\nHandle billing for {{account}}.\n\n## n2\nWrap up.\n\nOpen each call with: "Hi there."\n');
    expect(draft.tools.map((t) => t.name)).toEqual(["billing_lookup", "end_call"]);
    expect(draft.tasks[0]!.context).toEqual({ account: "ACME-1" });
    expect(draft.warnings).toEqual(["the prompt uses template variables ({{account}}): sandtable doesn't fill them, so give their values in a task's given.context, which the agent is shown"]);
  });

  it("lets the caller speak first with no first message, and drafts a placeholder with no prompt", () => {
    expect(draftFromElevenLabs(files(["a.json", elAgent({}, {}, { first_message: "" })])).policy).toBe("# Desk\n\nBe helpful.\n\nLet the caller speak first.\n");
    const empty = draftFromElevenLabs(files(["a.json", elAgent({ prompt: "" })]));
    expect(empty.policy).toMatch(/^# Policy\n\nTODO/);
    expect(empty.warnings).toContain("a.json: the agent has no conversation_config.agent.prompt.prompt, so policy.md is a placeholder");
  });
});

describe("import elevenlabs: tools", () => {
  it("drafts a webhook's params from its path, query and body schemas, keeping only what the LLM fills, and its http route", () => {
    const update = webhook("update_item", {
      url: "{{base_url}}/items/{item_id}?v=2",
      method: "PATCH",
      path_params_schema: { item_id: { type: "string", description: "The item" } },
      query_params_schema: { properties: { notify: { type: "boolean", description: "Send a notice" }, account: { type: "string", dynamic_variable: "account_id" } }, required: ["notify"] },
      request_body_schema: {
        type: "object",
        properties: {
          status: { type: "string", description: "New status", enum: ["open", "closed"] },
          reason: { type: "string", description: "Why", allowed_values: { dynamic_variable: "reasons" } },
          source: { type: "string", constant_value: "phone" },
          caller: { type: "string", is_system_provided: true },
          internal: { type: "string", is_omitted: true },
          loose: { type: "string" },
          address: { type: "object", description: "Where", properties: { zip: { type: "string", description: "Zip" }, region: { type: "string", dynamic_variable: "region" } }, required: ["zip"] },
          tags: { type: "array", description: "Tags", items: { type: "string" } },
          count: { type: ["integer", "null"], description: "How many" },
        },
        required: ["status", "address"],
      },
    });
    const { draft, domain } = domainOf(files(["a.json", elAgent({ tool_ids: ["u"] })], ["u.json", { id: "u", tool_config: update }]));
    const tool = domain.tools.find((t) => t.name === "update_item")!;
    expect(tool.http).toEqual({ method: "PATCH", path: "/items/{item_id}" });
    expect(tool.params).toEqual({
      item_id: { type: "string", required: true, description: "The item" },
      notify: { type: "boolean", required: true, description: "Send a notice" },
      status: { type: "string", required: true, description: "New status", enum: ["open", "closed"] },
      reason: { type: "string", required: false, description: "Why" },
      address: { type: "object", required: true, description: "Where", properties: { zip: { type: "string", required: true, description: "Zip" } } },
      tags: { type: "array", required: false, description: "Tags", items: { type: "string", required: true } },
      count: { type: "integer", required: false, description: "How many" },
    });
    expect(draft.tools[0]!.notes).toEqual([
      "No test mocks it, so what it returns is unknown: model what it reads and changes with get, list, create or update ops on a table (ElevenLabs calls PATCH {{base_url}}/items/{item_id}?v=2 for it).",
      'Parameter "account" comes from the dynamic variable {{account_id}}, so it was left out: the agent never fills it.',
      'Parameter "reason" accepts only the values in the dynamic variable {{reasons}}, which ElevenLabs checks itself (allowed_values): add an enum or a check if that matters.',
      'Parameter "source" is the constant "phone", so it was left out: the agent never fills it.',
      'Parameter "caller" is filled in by ElevenLabs (is_system_provided), so it was left out: the agent never fills it.',
      'Parameter "internal" is omitted from the request (is_omitted), so it was left out.',
      'Parameter "loose" has no description, so the LLM doesn\'t fill it: it was left out.',
      'Parameter "address.region" comes from the dynamic variable {{region}}, so it was left out: the agent never fills it.',
      "Its http route is its URL's path: to grade the agent's own test calls with sandtable serve, point the tool's base URL at the world server.",
    ]);
    expect(draft.warnings).toEqual([]);
  });

  it("drafts no http route where the world server has one, another tool has it, or a placeholder isn't a param", () => {
    const tools = [
      webhook("reserved", { url: "https://x.example/webhook/orders", method: "POST" }),
      webhook("first", { url: "https://x.example/items/{id}", path_params_schema: { id: { type: "string", description: "Id" } } }),
      webhook("second", { url: "https://x.example/items/{item}", path_params_schema: { item: { type: "string", description: "Item" } } }),
      webhook("acct", { url: "https://x.example/accounts/{account}/items", path_params_schema: { account: { type: "string", dynamic_variable: "account_id" } } }),
    ];
    const { draft, domain } = domainOf(files(["a.json", elAgent({ tool_ids: ["w1", "w2", "w3", "w4"] })], ...tools.map((t, i): [string, unknown] => [`w${i + 1}.json`, { id: `w${i + 1}`, tool_config: t }])));
    expect(domain.tools.map((t) => [t.name, t.http?.path])).toEqual([
      ["reserved", undefined],
      ["first", "/items/{id}"],
      ["second", undefined],
      ["acct", undefined],
      ["end_call", undefined],
    ]);
    expect(draft.warnings).toEqual([
      'w1.json: no http route for webhook tool "reserved" (/webhook/orders is one of the world server\'s own routes (/tools, /mcp, /webhook, /sessions, /s): choose another path); sandtable serve still serves it at /tools/reserved',
      'w3.json: no http route for webhook tool "second" (GET /items/{item} is tools.first\'s route too); sandtable serve still serves it at /tools/second',
      'w4.json: no http route for webhook tool "acct" ({account} is not a param of acct); sandtable serve still serves it at /tools/acct',
    ]);
  });

  it("skips the system tools, code and MCP tools ElevenLabs runs itself", () => {
    const d = draftFromElevenLabs(
      files(
        [
          "a.json",
          elAgent({
            tool_ids: ["m1", "c1"],
            built_in_tools: {
              end_call: END_CALL,
              transfer_to_agent: { type: "system", name: "transfer_to_agent", params: { system_tool_type: "transfer_to_agent", transfers: [] } },
              language_detection: null,
              skip_turn: { type: "system", name: "skip_turn", params: { system_tool_type: "skip_turn" } },
            },
          }),
        ],
        ["m1.json", { id: "m1", tool_config: { type: "mcp", value: {} } }],
        ["c1.json", { id: "c1", tool_config: { type: "code", name: "calc" } }],
      ),
    );
    expect(d.tools.map((t) => t.name)).toEqual(["end_call"]);
    expect(d.warnings).toEqual([
      "m1.json: an mcp tool, which ElevenLabs runs itself, has no sandtable counterpart; skipped",
      "c1.json: a code tool, which ElevenLabs runs itself, has no sandtable counterpart; skipped",
      "a.json: a transfer_to_agent system tool, which ElevenLabs runs itself, has no sandtable counterpart; skipped",
      "a.json: a skip_turn system tool, which ElevenLabs runs itself, has no sandtable counterpart; skipped",
    ]);
  });
});

describe("import elevenlabs: tests", () => {
  const order = webhook("order", {
    url: "https://desk.example/orders",
    method: "POST",
    request_body_schema: {
      type: "object",
      properties: {
        qty: { type: "integer", description: "How many" },
        item: { type: "object", description: "The item", properties: { sku: { type: "string", description: "SKU" } } },
        note: { type: "string", description: "A note" },
        mood: { type: "string", description: "Mood" },
        who: { type: "string", description: "Who" },
      },
    },
  });
  const lookup = webhook("lookup", { url: "https://desk.example/items/{item_id}", path_params_schema: { item_id: { type: "string", description: "The item" } } });
  const base = () => [
    ["a.json", elAgent({ tool_ids: ["tool_q", "tool_l", "tool_n"] })],
    ["q.json", { id: "tool_q", tool_config: order }],
    ["l.json", { id: "tool_l", tool_config: lookup, response_mocks: [{ mock_result: '{"item_id":"9","status":"old"}' }] }],
    ["n.json", { id: "tool_n", tool_config: webhook("note_it", { url: "https://desk.example/notes", method: "POST" }) }],
  ] as [string, unknown][];

  it("makes a simulation a task: its scenario, variables, turns and mocks, with its success conditions noted", () => {
    const { draft, domain } = domainOf(
      files(...base(), [
        "s.json",
        {
          id: "s1",
          type: "simulation",
          name: "Lost item",
          simulation_scenario: "You lost item 7.",
          simulation_max_turns: 6,
          success_conditions: ["Finds it"],
          success_condition: "Is kind",
          dynamic_variables: { tier: "gold" },
          tool_mock_config: { mocking_strategy: "selected", mocked_tool_ids: ["tool_n"] },
          tool_mock_overrides: { tool_l: [{ mock_result: '{"item_id":"7","status":"lost"}', parameter_conditions: [] }], tool_n: [{ mock_result: "boom", is_error: true }], ghost: [{ mock_result: "x" }] },
        },
      ]),
    );
    expect(domain.tasks[0]).toMatchObject({
      id: "lost-item",
      user: { instructions: "You lost item 7.", opening: "Hi.", script: ["Hi."] },
      given: { rows: { lookup_results: [{ item_id: "7", status: "lost" }] }, context: { tier: "gold" } },
      expect: { called: ["lookup"] },
      max_turns: 6,
    });
    expect(draft.tasks[0]!.notes).toEqual([
      'Its test mocks note_it to fail ("boom"): model that failure with a fault or a check, which this draft leaves out.',
      'ElevenLabs judged it with an LLM on: "Finds it"; "Is kind". sandtable doesn\'t: write each as expect.state, called or not_called, which sandtable grades without a model.',
      "The test mocked lookup, so the task expects a successful call of each: check that, and add the end state.",
      "Its opening and script are placeholders for runs with --user scripted: write the caller's lines.",
    ]);
    expect(draft.warnings).toEqual(["s.json: a tool mock for ghost, which the agent doesn't have; skipped"]);
  });

  it("makes a tool test a task that expects the call, its exact arguments as a where clause on them, and replays the user's lines", () => {
    const { draft, domain } = domainOf(
      files(
        ...base(),
        [
          "u.json",
          {
            id: "u1",
            type: "tool",
            name: "Counts",
            chat_history: [
              { role: "user", time_in_call_secs: 1, message: "I need 3 of item 7." },
              { role: "agent", time_in_call_secs: 2, message: "Sure." },
              { role: "user", time_in_call_secs: 3, message: "Yes, three." },
            ],
            tool_call_parameters: {
              referenced_tool: { id: "tool_q", type: "webhook" },
              parameters: [
                { path: "qty", eval: { type: "exact", expected_value: "3" } },
                { path: "item.sku", eval: { type: "exact", expected_value: "7" } },
                { path: "note", eval: { type: "regex", pattern: "^thr" } },
                { path: "mood", eval: { type: "llm", description: "Sounds happy" } },
                { path: "who", eval: { type: "anything" } },
              ],
              verify_absence: false,
            },
          },
        ],
        ["v.json", { id: "v1", type: "tool", name: "Never ends early", chat_history: [{ role: "user", message: "Wait." }], tool_call_parameters: { referenced_tool: { id: "end_call", type: "system" }, verify_absence: true } }],
        ["g.json", { id: "g1", type: "tool", name: "Ghost", chat_history: [{ role: "user", message: "Hi." }], tool_call_parameters: { referenced_tool: { id: "nope", type: "webhook" } } }],
      ),
    );
    const [counts, never, ghost] = domain.tasks;
    expect(counts).toMatchObject({
      user: { instructions: 'In this call you say, in order: "I need 3 of item 7.", then "Yes, three."', opening: "I need 3 of item 7.", script: ["I need 3 of item 7.", "Yes, three."] },
      expect: { called: [{ tool: "order", args: { qty: 3, "item.sku": "7" } }] },
    });
    expect(draft.tasks[0]!.notes).toEqual([
      "ElevenLabs checked order's note against the pattern ^thr: where clauses have no regex yet (#20), so check it another way, such as $contains.",
      'ElevenLabs judged order\'s mood with an LLM ("Sounds happy"): write the value it expects as an argument of the expected call.',
      "ElevenLabs tested the agent's next turn after this chat history; a run plays the whole call, with the user's lines in order whatever the agent says, so check that they still make sense.",
      "It expects the call ElevenLabs checked: check that, and add the end state.",
    ]);
    expect(never!.expect).toMatchObject({ called: [], not_called: ["end_call"] });
    expect(ghost!.expect).toMatchObject({ called: [], not_called: [] });
    expect(draft.warnings).toEqual(["g.json: the test's tool_call_parameters name the tool nope, which the agent doesn't have; skipped"]);
  });

  it("makes a next-reply test a task, with its success condition and examples noted", () => {
    const { draft } = domainOf(
      files(...base(), [
        "r.json",
        {
          id: "r1",
          type: "llm",
          name: "Greets",
          chat_history: [{ role: "user", time_in_call_secs: 1, message: "Hello" }],
          success_condition: "Greets the caller",
          success_examples: [{ response: "Hi!", type: "success" }],
          failure_examples: [{ response: "What?", type: "failure" }],
        },
      ]),
    );
    expect(draft.tasks[0]!.notes).toEqual([
      'ElevenLabs judged the agent\'s next reply with an LLM: "Greets the caller". Replies it counted as passing: "Hi!". Replies it counted as failing: "What?". sandtable doesn\'t: write it as reply_includes, expect.state, called or not_called, which sandtable grades without a model.',
      "ElevenLabs tested the agent's next turn after this chat history; a run plays the whole call, with the user's lines in order whatever the agent says, so check that they still make sense.",
      "Nothing is graded yet: add the end state (expect.state) or the tools a correct call uses (expect.called).",
    ]);
  });

  it("imports only the tests attached to the agent, when it lists them", () => {
    const d = draftFromElevenLabs(
      files(
        ["a.json", elAgent({}, { platform_settings: { testing: { attached_tests: [{ test_id: "s1" }] } } })],
        ["s1.json", { id: "s1", type: "simulation", name: "One", simulation_scenario: "One." }],
        ["s2.json", { id: "s2", type: "simulation", name: "Two", simulation_scenario: "Two." }],
      ),
    );
    expect(d.tasks.map((t) => t.id)).toEqual(["one"]);
    expect(d.warnings).toEqual(["s2.json: a test the agent doesn't list in platform_settings.testing.attached_tests; skipped"]);
  });
});

describe("import elevenlabs: drafts validate from awkward configs (review of #469)", () => {
  it("drafts a tool in both tool_ids and the inline list once, one transfer target once, no route with a space, and notes a mock's conditions", () => {
    const item = webhook("get thing", { url: "https://desk.example/items/{item_id}", path_params_schema: { item_id: { type: "string", description: "The item" } } });
    const transfer = { transfer_destination: { type: "phone", phone_number: "+15555550103" }, condition: "Billing" };
    const { draft, domain } = domainOf(
      files(
        ["agent.json", { agent_id: "agent_9", ...elAgent({ tool_ids: ["t1", "t3"], tools: [{ id: "t1", ...item }], built_in_tools: { end_call: { ...END_CALL, name: "End Call!" }, transfer_to_number: { type: "system", name: "transfer_to_number", params: { system_tool_type: "transfer_to_number", transfers: [transfer, { ...transfer, condition: "Payments" }] } } } }) }],
        ["t1.json", { id: "t1", tool_config: item }],
        ["t3.json", { id: "t3", tool_config: webhook("spaced", { url: "https://desk.example/my path/x", method: "POST" }) }],
        [
          "s.json",
          {
            id: "s1",
            type: "simulation",
            name: "Lost item",
            simulation_scenario: "You lost item 7.",
            tool_mock_config: { mocking_strategy: "none" },
            tool_mock_overrides: { t1: [{ mock_result: '{"item_id":"7","status":"lost"}', parameter_conditions: [{ path: "item_id", value: "7" }] }] },
          },
        ],
      ),
    );
    // The built-in end call's name is made a valid tool name, as a custom tool's is.
    expect(draft.tools.map((t) => [t.name, t.platformName])).toEqual([["get_thing", "get thing"], ["spaced", undefined], ["end_call", "End Call!"], ["transfer_to_number", undefined]]);
    expect(domain.tools.find((t) => t.name === "transfer_to_number")!.params.destination!.enum).toEqual(["+15555550103"]);
    expect(domain.tools.find((t) => t.name === "spaced")!.http).toBeUndefined();
    expect(domain.tools.find((t) => t.name === "get_thing")!.http).toEqual({ method: "GET", path: "/items/{item_id}" });
    expect(draft.tasks[0]!.notes.join("\n")).toContain('Its test answers get_thing with this mock only for some arguments ([{"path":"item_id","value":"7"}])');
    expect(validateDomain(domain)).toEqual([]);
  });
});
