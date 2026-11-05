import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { draftFromRetell, renderRetellDraft, retellProblem } from "../src/init/retell.ts";
import type { PlatformFile } from "../src/init/platform.ts";
import { lintDomain } from "../src/grade/lint.ts";
import { runSuite } from "../src/run/suite.ts";
import { noopAgent } from "../src/sim/noop.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import { domainWarnings, loadDomain, parseDomain, pendingReview, validateDomain } from "../src/spec/load.ts";

// sandtable import retell (#35): a draft domain from a Retell agent, its Retell LLM or conversation flow, and its test cases.

const run = promisify(execFile);
const cli = path.resolve("src/cli.ts");
const example = path.resolve("examples/retell");

const agent = (extra: Record<string, unknown> = {}) => ({ agent_id: "agent_1", agent_name: "Desk", response_engine: { type: "retell-llm", llm_id: "llm_1" }, ...extra });
const llm = (extra: Record<string, unknown> = {}) => ({ llm_id: "llm_1", general_prompt: "Be helpful.", general_tools: [{ type: "end_call", name: "end_call" }], ...extra });
const custom = (name: string, properties: Record<string, unknown> = {}, required: string[] = [], extra: Record<string, unknown> = {}) => ({
  type: "custom",
  name,
  description: `${name} does it`,
  url: `https://desk.example/${name}`,
  method: "POST",
  parameters: { type: "object", properties, required },
  ...extra,
});
const testCase = (name: string, extra: Record<string, unknown> = {}) => ({
  test_case_definition_id: `tc_${name}`,
  type: "simulation",
  name,
  response_engine: { type: "retell-llm", llm_id: "llm_1" },
  user_prompt: `You are ${name}.`,
  metrics: [],
  dynamic_variables: {},
  tool_mocks: [],
  llm_model: "gpt-4.1",
  ...extra,
});
const files = (...items: [string, unknown][]): PlatformFile[] => items.map(([file, json]) => ({ file, json }));

/** The draft as the domain its files make, parsed and cross-checked as a loaded one is. */
function domainOf(f: PlatformFile[], pick?: string) {
  const d = draftFromRetell(f, pick);
  const r = renderRetellDraft(d);
  return { draft: d, domain: parseDomain({ ...YAML.parse(r.domain), policy: d.policy, tasks: YAML.parse(r.tasks) }) };
}

describe("import retell: the bundled example", () => {
  it.skipIf(!process.features.typescript)("imports, validates, lints and runs with the scripted user from the CLI", { timeout: 30_000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-import-retell-"));
    const out = path.join(dir, "pinecrest");
    const imported = await run(process.execPath, [cli, "import", "retell", example, "-o", out]);
    expect(imported.stdout).toContain("Imported pinecrest-bike-repair from Retell: 3 tools, 2 tables, 2 tasks, 4 judged criteria, all pending review.");
    expect(imported.stdout).toContain("{{customer_phone}}");
    expect(imported.stdout).toContain("/webhook/<tool>");
    const domain = await loadDomain(out);
    expect(domain.tools.map((t) => t.name)).toEqual(["get_repair", "transfer_to_mechanic", "end_call"]);
    expect(domain.policy).toMatch(/^# Pinecrest Bike Repair\n\nYou are the phone assistant for Pinecrest Bike Repair/);
    expect(domain.policy).toContain('Open each call with: "Thanks for calling Pinecrest Bike Repair, this is the service desk. How can I help?"');
    expect(domain.tools.find((t) => t.name === "get_repair")).toMatchObject({ params: { ticket_id: { type: "string", required: true } }, ops: [{ get: "get_repair_results", key: "$ticket_id" }], review: "pending" });
    expect(domain.tools.find((t) => t.name === "transfer_to_mechanic")!.params.destination!.enum).toEqual(["+15555550100"]);
    const [ready, parts] = domain.tasks;
    expect(ready).toMatchObject({
      id: "repair-status-for-a-bike-that-s-ready",
      source: { file: path.join("tests", "repair-ready.json") },
      given: { rows: { get_repair_results: [{ ticket_id: "R-2041", status: "ready", balance_due: 85 }] }, context: { customer_phone: "+15555550142" } },
      expect: { called: [{ tool: "get_repair", args: { ticket_id: "R-2041" } }] },
    });
    // A test case with no dynamic variables gets the LLM's defaults.
    expect(parts).toMatchObject({ given: { context: { shop_hours: "Tuesday to Saturday, 9am to 6pm" } }, expect: { called: ["get_repair", "transfer_to_mechanic"] } });
    const tasksYaml = await readFile(path.join(out, "tasks.yaml"), "utf8");
    expect(tasksYaml).not.toContain("LLM judge");
    expect(ready!.judged![0]).toEqual({
      id: "repair-status-for-a-bike-that-s-ready-judged-1",
      criterion: "The agent tells the caller the bike is ready and that $85 is due",
      source: { file: path.join("tests", "repair-ready.json"), quote: "The agent tells the caller the bike is ready and that $85 is due" },
      review: "pending",
    });
    expect(parts!.judged!.map((c) => c.criterion)).toEqual(["The agent says the bike is waiting for parts", "The agent transfers the call to a mechanic for the brake question"]);
    expect(pendingReview(domain).length).toBeGreaterThanOrEqual(4);
    // `review` shows its source and quote, with no TODO note of its own, and --strict fails until it is accepted too.
    expect((await run(process.execPath, [cli, "review", out])).stdout).toContain(
      `- criterion repair-status-for-a-bike-that-s-ready-judged-1  (${path.join("tests", "repair-ready.json")})\n    "The agent tells the caller the bike is ready and that $85 is due"\n- criterion repair-status-for-a-bike-that-s-ready-judged-2`,
    );
    const strict = () => run(process.execPath, [cli, "validate", out, "--strict"]).then(() => ({ code: 0, stdout: "" }), (e: { code: number; stdout: string }) => e);
    const accepted = await readFile(path.join(out, "sandtable.yaml"), "utf8");
    await writeFile(path.join(out, "sandtable.yaml"), accepted.replaceAll("review: pending", "review: accepted"));
    await writeFile(path.join(out, "tasks.yaml"), tasksYaml.replaceAll(/^ {2}review: pending$/gm, "  review: accepted"));
    expect(await strict()).toMatchObject({ code: 1, stdout: expect.stringContaining("⚠ 4 drafted item(s) pending review") });
    await writeFile(path.join(out, "tasks.yaml"), tasksYaml.replaceAll("review: pending", "review: accepted"));
    expect((await strict()).code).toBe(0);
    expect((await run(process.execPath, [cli, "validate", out])).stdout).toContain("2 tables, 3 tools, 0 invariants, 2 tasks");
    expect((await run(process.execPath, [cli, "lint", out])).stdout).toContain("0 error(s)");
    const r = await runSuite({ domain, agent: noopAgent(), user: scriptedUser() });
    expect(r.tasks.every((t) => t.passes === 0)).toBe(true);
    expect(lintDomain(domain).errors).toBe(0);
    expect(await run(process.execPath, [cli, "import", "retell", example, "-o", out]).catch((e: { code: number; stderr: string }) => e)).toMatchObject({ code: 2, stderr: expect.stringContaining("refusing to overwrite") });
  });

  it.skipIf(!process.features.typescript)("refuses a custom LLM, two agents without --agent, and an agent with no tool it can model", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-import-retell-bad-"));
    const fail = (...args: string[]) => run(process.execPath, [cli, ...args]).catch((e: { code: number; stderr: string }) => e);
    await writeFile(path.join(dir, "custom.json"), JSON.stringify(agent({ response_engine: { type: "custom-llm", llm_websocket_url: "wss://desk.example/llm" } })));
    expect(await fail("import", "retell", path.join(dir, "custom.json"), "-o", path.join(dir, "out"))).toMatchObject({ code: 2, stderr: expect.stringContaining("uses a custom LLM") });
    await writeFile(path.join(dir, "two.json"), JSON.stringify([agent({ agent_name: "A", agent_id: "agent_a" }), agent({ agent_name: "B", agent_id: "agent_b" }), llm()]));
    expect(await fail("import", "retell", path.join(dir, "two.json"), "-o", path.join(dir, "out"))).toMatchObject({ code: 2, stderr: expect.stringContaining("has 2 agents (A, B): pick one with --agent <name or id>") });
    expect((await run(process.execPath, [cli, "import", "retell", path.join(dir, "two.json"), "--agent", "agent_b", "-o", path.join(dir, "b")])).stdout).toContain("Imported b from Retell");
    expect(await fail("import", "retell", path.join(dir, "two.json"), "--agent", "C", "-o", path.join(dir, "out"))).toMatchObject({ code: 2, stderr: expect.stringContaining('has no agent named or with the id "C" (it has A, B)') });
    await writeFile(path.join(dir, "notools.json"), JSON.stringify([agent(), llm({ general_tools: [{ type: "press_digit", name: "press_digit" }] })]));
    const r = await fail("import", "retell", path.join(dir, "notools.json"), "-o", path.join(dir, "out"));
    expect(r).toMatchObject({ code: 2, stderr: expect.stringContaining("the agent has no tool sandtable can model, and a domain needs one") });
    expect((r as { stderr: string }).stderr).toContain("a press_digit tool, which Retell runs itself, has no sandtable counterpart; skipped");
  });
});

describe("import retell: the files", () => {
  it("classifies agents, LLMs, flows and test cases, test case lists included, and says what it skipped", () => {
    const d = draftFromRetell(
      files(
        ["agent.json", agent()],
        ["llm.json", llm()],
        ["other-llm.json", llm({ llm_id: "llm_2" })],
        ["tests.json", { items: [testCase("A"), testCase("B")], has_more: false, pagination_key: "x" }],
        ["more.json", [testCase("C"), testCase("D", { response_engine: { type: "retell-llm", llm_id: "llm_2" } })]],
        ["junk.json", { hello: 1 }],
      ),
    );
    expect(d.tasks.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(d.warnings).toEqual([
      "junk.json: not a Retell agent (with agent_id or response_engine), Retell LLM (with llm_id), conversation flow (with nodes) or test case (with user_prompt and metrics); skipped",
      "other-llm.json: a Retell LLM the agent doesn't use (its response_engine names llm_1); skipped",
      "more.json: a test case for another response engine (llm_2); skipped",
    ]);
  });

  it("says why it can't import", () => {
    expect(retellProblem(files(["t.json", testCase("A")]))).toMatch(/^has no Retell agent, Retell LLM or conversation flow/);
    expect(retellProblem(files(["a.json", agent()]))).toBe("the agent \"Desk\" runs on the Retell LLM llm_1, which no file in the export has: add it with GET https://api.retellai.com/get-retell-llm/llm_1");
    expect(retellProblem(files(["a.json", agent({ response_engine: { type: "conversation-flow", conversation_flow_id: "cf_1" } })]))).toMatch(/GET https:\/\/api\.retellai\.com\/get-conversation-flow\/cf_1$/);
    expect(retellProblem(files(["a.json", agent({ response_engine: { type: "custom-llm", llm_websocket_url: "wss://x" } })]))).toMatch(/uses a custom LLM/);
    expect(retellProblem(files(["a.json", agent()], ["l.json", llm()]))).toBeUndefined();
    // An LLM or flow alone is enough; two need --agent, by id.
    expect(retellProblem(files(["l.json", llm()]))).toBeUndefined();
    expect(retellProblem(files(["l.json", [llm(), llm({ llm_id: "llm_2" })]]))).toBe("has 2 Retell LLMs or conversation flows and no agent (llm_1, llm_2): pick one with --agent <id>");
    expect(retellProblem(files(["l.json", [llm(), llm({ llm_id: "llm_2" })]]), "llm_2")).toBeUndefined();
    expect(draftFromRetell(files(["l.json", [llm(), llm({ llm_id: "llm_2", general_prompt: "Second." })]]), "llm_2").policy).toContain("Second.");
  });

  it("takes the agent's engine embedded in a dashboard export", () => {
    const { draft } = domainOf(files(["export.json", { agent_name: "Desk", response_engine: { type: "retell-llm", llm_id: "llm_9" }, retellLlmData: llm({ llm_id: "llm_9", general_prompt: "Embedded." }) }]));
    expect(draft.policy).toBe("# Desk\n\nEmbedded.\n");
    const flow = draftFromRetell(files(["export.json", { agent_name: "Flow", response_engine: { type: "conversation-flow" }, conversationFlow: { global_prompt: "Flowing.", nodes: [{ id: "end", type: "end" }] } }]));
    expect(flow.policy).toBe("# Flow\n\nFlowing.\n");
    expect(flow.tools.map((t) => t.name)).toEqual(["end_call"]);
  });
});

describe("import retell: policy", () => {
  it("is the general prompt, then each state's prompt, the starting state and the opening line", () => {
    const { draft } = domainOf(
      files(
        ["agent.json", agent()],
        [
          "llm.json",
          llm({
            general_prompt: "You run the desk for {{shop}}.",
            states: [
              { name: "greeting", state_prompt: "Greet the caller.", edges: [{ destination_state_name: "booking", description: "They want to book." }] },
              { name: "booking", state_prompt: "Book it on {{day}}." },
            ],
            starting_state: "greeting",
            begin_message: "Hello!",
            default_dynamic_variables: { shop: "Pinecrest" },
          }),
        ],
        ["t1.json", testCase("Has variables", { dynamic_variables: { shop: "Elmwood" } })],
        ["t2.json", testCase("Has none")],
      ),
    );
    expect(draft.policy).toBe('# Desk\n\nYou run the desk for {{shop}}.\n\n## greeting\nGreet the caller.\n\n## booking\nBook it on {{day}}.\n\nThe call starts in the state "greeting".\n\nOpen each call with: "Hello!"\n');
    expect(draft.warnings).toContain("the prompt uses template variables ({{shop}}, {{day}}): sandtable doesn't fill them, so give their values in a task's given.context, which the agent is shown");
    expect(draft.warnings).toContain("llm.json: the states' edges are transition tools inside Retell (transition_to_booking), not your API; skipped");
    expect(draft.tasks.map((t) => t.context)).toEqual([{ shop: "Elmwood" }, { shop: "Pinecrest" }]);
  });

  it("lets the caller speak first when begin_message is empty, and drafts a placeholder without a prompt", () => {
    expect(draftFromRetell(files(["l.json", llm({ begin_message: "" })])).policy).toBe("# llm_1\n\nBe helpful.\n\nLet the caller speak first.\n");
    const empty = draftFromRetell(files(["l.json", llm({ general_prompt: null })]));
    expect(empty.policy).toMatch(/^# Policy\n\nTODO/);
    expect(empty.warnings).toContain("l.json: the Retell LLM has no general_prompt or state prompt, so policy.md is a placeholder");
  });

  it("is a flow's global prompt and its conversation nodes' instructions", () => {
    const flow = {
      conversation_flow_id: "cf_1",
      global_prompt: "Be brief.",
      start_node_id: "start",
      nodes: [
        { id: "start", name: "Greeting", type: "conversation", instruction: { type: "static_text", text: "Thanks for calling." } },
        { id: "ask", type: "conversation", instruction: { type: "prompt", text: "Ask for the ticket." } },
      ],
    };
    expect(draftFromRetell(files(["f.json", flow])).policy).toBe("# cf_1\n\nBe brief.\n\n## Greeting\nThanks for calling.\n\n## ask\nAsk for the ticket.\n");
  });
});

describe("import retell: tools", () => {
  it("drafts custom functions, leaving out const params, and end_call and transfer_call as Vapi's are", () => {
    const tools = [
      custom("get_order", { order_id: { type: "string", description: "The order" }, source: { type: "string", const: "phone" }, who: { type: "object", properties: { first: { type: "string" }, last: { type: "string", const: "{{last_name}}" } } } }, ["order_id"]),
      custom("list_slots", {}, [], { method: "GET" }),
      { type: "transfer_call", name: "transfer_to_desk", description: "Transfer to the front desk.", transfer_destination: { type: "predefined", number: "+15555550101" }, transfer_option: { type: "cold_transfer" } },
      { type: "transfer_call", name: "transfer_smart", transfer_destination: { type: "inferred", prompt: "Pick the right team." }, transfer_option: { type: "cold_transfer" } },
      { type: "press_digit", name: "press_digit" },
      { type: "check_availability_cal", name: "check_availability" },
      { type: "agent_swap", name: "swap" },
    ];
    const { draft, domain } = domainOf(files(["agent.json", agent()], ["llm.json", llm({ general_tools: tools, states: [{ name: "s", tools: [{ type: "end_call", name: "end_call" }, custom("cancel", { id: { type: "string" } }, ["id"])] }] })]));
    expect(domain.tools.map((t) => t.name)).toEqual(["get_order", "list_slots", "transfer_to_desk", "transfer_smart", "end_call", "cancel"]);
    const order = draft.tools[0]!;
    expect(Object.keys(order.params)).toEqual(["order_id", "who"]);
    expect(order.params.who!.properties).toEqual({ first: { type: "string", required: false } });
    expect(order.notes).toEqual([
      "No test case mocks it, so what it returns is unknown: model what it reads and changes with get, list, create or update ops on a table (Retell calls POST https://desk.example/get_order for it).",
      'Parameter "source" is a fixed value (const "phone") in the Retell config, so it was left out: the agent never fills it.',
      'Parameter "who.last" is a fixed value (const "{{last_name}}") in the Retell config, so it was left out: the agent never fills it.',
      "To grade the agent's own test calls with sandtable serve, set its URL to the world server's /webhook/get_order: that route takes Retell's request with or without args_at_root.",
    ]);
    expect(domain.tools.find((t) => t.name === "transfer_to_desk")).toMatchObject({ description: "Transfer to the front desk. Destinations: +15555550101.", params: { destination: { enum: ["+15555550101"] } }, ops: [{ create: "transfers" }, { respond: {} }] });
    expect(domain.tools.find((t) => t.name === "transfer_smart")!.description).toBe("Transfer the call to a person. Destinations: a number Retell infers (Pick the right team.).");
    expect(domain.tools.find((t) => t.name === "transfer_smart")!.params.destination!.enum).toBeUndefined();
    expect(draft.tables).toEqual({ transfers: { key: "transfer_id" } });
    expect(draft.warnings).toEqual([
      'llm.json: custom function "list_slots" uses GET, and Retell sends the LLM\'s arguments only with POST, PUT or PATCH: check its params',
      "llm.json: a press_digit tool, which Retell runs itself, has no sandtable counterpart; skipped",
      "llm.json: a check_availability_cal tool, which Retell runs itself (it moved Cal.com tools to integration_app on 2026-10-31), has no sandtable counterpart; skipped",
      "llm.json: an agent_swap tool, which Retell runs itself, has no sandtable counterpart; skipped",
    ]);
  });

  it("takes end_call from the LLM once, though a state has it too", () => {
    const d = draftFromRetell(files(["l.json", llm({ states: [{ name: "s", tools: [{ type: "end_call", name: "end_call" }] }] })]));
    expect(d.tools.map((t) => t.name)).toEqual(["end_call"]);
    expect(d.warnings).toEqual([]);
  });

  it("takes a flow's tools, its end and transfer nodes, and skips its other nodes", () => {
    const flow = {
      conversation_flow_id: "cf_1",
      global_prompt: "Be brief.",
      tools: [custom("lookup", { id: { type: "string", description: "The id" } }, ["id"], { tool_id: "tool_1" }), { type: "integration_app", name: "crm", tool_id: "tool_2" }],
      nodes: [
        { id: "fn", type: "function", tool_id: "tool_1", tool_type: "local", wait_for_result: true },
        { id: "fn2", type: "function", tool_id: "tool_9", tool_type: "local", wait_for_result: true },
        { id: "bye", type: "end" },
        { id: "bye2", type: "end" },
        { id: "xfer", type: "transfer_call", transfer_destination: { type: "predefined", number: "+15555550102" }, transfer_option: { type: "cold_transfer" }, edge: {} },
        { id: "b1", type: "branch" },
        { id: "b2", type: "branch" },
        { id: "sms", type: "sms" },
      ],
    };
    const { draft, domain } = domainOf(files(["flow.json", flow]));
    expect(domain.tools.map((t) => t.name)).toEqual(["lookup", "end_call", "transfer_call"]);
    expect(domain.tools.find((t) => t.name === "transfer_call")!.params.destination!.enum).toEqual(["+15555550102"]);
    expect(draft.warnings).toEqual([
      "flow.json: an integration_app tool, which Retell runs itself, has no sandtable counterpart; skipped",
      "flow.json: function node fn2 calls tool_id tool_9, which the flow's tools don't have; skipped",
      "flow.json: 2 branch nodes have no sandtable counterpart; skipped",
      "flow.json: 1 sms node has no sandtable counterpart; skipped",
    ]);
  });
});

describe("import retell: test cases", () => {
  it("lifts tool mocks into rows or respond text and partial matches into expected arguments, and notes nothing about its metrics", () => {
    const tools = [custom("get_order", { order_id: { type: "string" }, source: { type: "string", const: "phone" } }, ["order_id"]), custom("note", { text: { type: "string" } }, ["text"]), { type: "transfer_call", name: "transfer", transfer_destination: { type: "predefined", number: "+15555550101" }, transfer_option: { type: "cold_transfer" } }];
    const { draft, domain } = domainOf(
      files(
        ["agent.json", agent()],
        ["llm.json", llm({ general_tools: tools })],
        [
          "t1.json",
          testCase("Shipped", {
            dynamic_variables: { tier: "gold" },
            metrics: ["Says it shipped", "Is polite"],
            tool_mocks: [
              { tool_name: "get_order", input_match_rule: { type: "partial_match", args: { order_id: "A1", source: "phone" } }, output: '{"order_id":"A1","status":"shipped"}' },
              { tool_name: "note", input_match_rule: { type: "any" }, output: "Saved." },
              { tool_name: "transfer", input_match_rule: { type: "any" }, output: "", result: true },
              { tool_name: "ghost", input_match_rule: { type: "any" }, output: "x" },
              { tool_name: "note", input_match_rule: { type: "any" } },
            ],
          }),
        ],
        ["t2.json", testCase("Quiet")],
      ),
    );
    expect(domain.tools.find((t) => t.name === "get_order")!.ops).toEqual([{ get: "get_order_results", key: "$order_id" }]);
    expect(domain.tools.find((t) => t.name === "note")!.ops).toEqual([{ respond: "Saved." }]);
    expect(domain.tools.find((t) => t.name === "transfer")!.ops).toMatchObject([{ create: "transfers" }, { respond: {} }]);
    const [shipped, quiet] = domain.tasks;
    expect(shipped).toMatchObject({
      user: { instructions: "You are Shipped.", opening: "Hi.", script: ["Hi."] },
      given: { rows: { get_order_results: [{ order_id: "A1", status: "shipped" }] }, context: { tier: "gold" } },
      expect: { called: [{ tool: "get_order", args: { order_id: "A1" } }, "note", "transfer"] },
    });
    expect(draft.tasks[0]!.notes).toEqual([
      'Its test case\'s mock of get_order matched calls with source = "phone", which isn\'t a param of get_order: left out of the expected call.',
      "The test case mocked get_order, note, transfer, so the task expects a successful call of each: check that, and add the end state.",
      "Its opening and script are placeholders for runs with --user scripted: write the caller's lines.",
    ]);
    expect(draft.warnings).toEqual(["t1.json: a tool mock for ghost, which the agent doesn't have; skipped", "t1.json: the tool mock for note has no output; skipped"]);
    expect(quiet!.expect).toMatchObject({ called: [] });
    expect(draft.tasks[1]!.notes[0]).toBe("Nothing is graded yet: add the end state (expect.state) or the tools a correct call uses (expect.called).");
    // Only the task with nothing to grade fails lint.
    expect(lintDomain(domain).tasks.filter((t) => t.errors.length).map((t) => t.id)).toEqual(["quiet"]);
  });
});

describe("import retell: drafts validate from awkward configs (review of #469)", () => {
  it("names built-in tools as tools may be named, drops a boolean's enum, keeps one row per mocked record, and reads a bare test case as a test", () => {
    const f = files(
      ["agent.json", agent()],
      [
        "llm.json",
        llm({
          general_tools: [
            { type: "end_call", name: "End Call!" },
            { type: "transfer_call", name: "transfer to sales", transfer_destination: { type: "predefined", number: "+15550100" } },
            custom("lookup", { id: { type: "string", description: "The ticket" }, urgent: { type: "boolean", enum: [true, false], description: "Rush it" }, tone: { type: "string", enum: ["calm", true, "brisk"], description: "How" } }, ["id"]),
          ],
        }),
      ],
      ["tests/repeat.json", testCase("repeat", { tool_mocks: [{ tool_name: "lookup", input_match_rule: { type: "any" }, output: JSON.stringify({ id: "7", status: "ready" }) }, { tool_name: "lookup", input_match_rule: { type: "any" }, output: JSON.stringify({ id: "7", status: "ready" }) }] })],
      // A test case trimmed by hand, without its id or metrics, is still a test, not a second agent.
      ["tests/bare.json", { name: "bare", response_engine: { type: "retell-llm", llm_id: "llm_1" }, user_prompt: "You are bare." }],
    );
    const { draft, domain } = domainOf(f);
    expect(draft.tools.map((t) => t.name)).toEqual(["end_call", "transfer_to_sales", "lookup"]);
    const lookup = domain.tools.find((t) => t.name === "lookup")!;
    expect(lookup.params.urgent).not.toHaveProperty("enum");
    expect(lookup.params.tone!.enum).toEqual(["calm", "brisk"]);
    expect(domain.tasks.map((t) => t.id)).toEqual(["repeat", "bare"]);
    expect(domain.tasks[0]!.given!.rows!.lookup_results).toEqual([{ id: "7", status: "ready" }]);
    expect(validateDomain(domain)).toEqual([]);
  });
});

describe("import retell: warnings for odd entries (#472)", () => {
  it("takes a list's test cases and warns about each other element, and names a tool or mock that names nothing", () => {
    const f = files(
      ["agent.json", agent()],
      ["llm.json", llm({ general_tools: [{ type: "end_call", name: "end_call" }, null, 5, "x", { name: "untyped" }, custom("lookup", { id: { type: "string", description: "The ticket" } }, ["id"])] })],
      ["tests.json", { items: [testCase("good", { tool_mocks: [{ input_match_rule: { type: "any" }, output: '{"id":"7"}' }] }), null, { foo: "bar" }] }],
    );
    const { draft, domain } = domainOf(f);
    expect(domain.tasks.map((t) => t.id)).toEqual(["good"]);
    // A mock with no tool_name is for no tool, not for the first one.
    expect(domain.tasks[0]!.expect.called).toEqual([]);
    expect(draft.warnings).toEqual(
      expect.arrayContaining([
        "tests.json: element 1 of its list isn't a test case (with user_prompt and metrics); skipped",
        "tests.json: element 2 of its list isn't a test case (with user_prompt and metrics); skipped",
        "llm.json: a tool that isn't a JSON object (null); skipped",
        "llm.json: a tool that isn't a JSON object (5); skipped",
        'llm.json: a tool that isn\'t a JSON object ("x"); skipped',
        "llm.json: a tool with no type; skipped",
        "tests.json: a tool mock for a tool with no tool_name, which the agent doesn't have; skipped",
      ]),
    );
    expect(draft.warnings.join("\n")).not.toContain("undefined");
    expect(validateDomain(domain)).toEqual([]);
  });
});

describe("import retell: metrics as judged criteria (#508)", () => {
  const withMetrics = (...metrics: unknown[]) => files(["agent.json", agent()], ["llm.json", llm()], ["tests/t1.json", testCase("Shipped", { metrics })]);
  const entry = (n: number, text: string) => ({ id: `shipped-judged-${n}`, criterion: text, source: { file: "tests/t1.json", quote: text }, review: "pending" });

  it("drafts each metric on its task, trimmed and in order, pending review with its file and text as its source", () => {
    const { draft, domain } = domainOf(withMetrics("  Says it shipped \n", "Is polite"));
    expect(domain.tasks[0]!.judged).toEqual([entry(1, "Says it shipped"), entry(2, "Is polite")]);
    expect(pendingReview(domain).filter((p) => p.kind === "criterion")).toEqual([
      { kind: "criterion", id: "shipped-judged-1", source: { file: "tests/t1.json", quote: "Says it shipped" } },
      { kind: "criterion", id: "shipped-judged-2", source: { file: "tests/t1.json", quote: "Is polite" } },
    ]);
    // A task with criteria stays pending itself, and they get no note: their source says where they came from.
    expect(domain.tasks[0]!.review).toBe("pending");
    expect(draft.tasks[0]!.notes.join("\n")).not.toMatch(/Says it shipped|judge/i);
    expect(renderRetellDraft(draft).tasks).not.toMatch(/judged:[\s\S]*# TODO/);
  });

  it("keeps text YAML must quote, as written, and warns about a ${today} as text, since a draft sets no clock", () => {
    const texts = ["Says: the pickup is ${today+2d} # soon", "{{shop}} is open", "Line one\nLine two: more"];
    const { domain } = domainOf(withMetrics(...texts));
    expect(domain.tasks[0]!.judged).toEqual(texts.map((t, i) => entry(i + 1, t)));
    expect(validateDomain(domain)).toEqual([]);
    expect(domainWarnings(domain).filter((w) => w.includes("judged"))).toEqual([expect.stringContaining('tasks.shipped.judged[0].criterion: "${today+2d}" is text, not a date, since the domain sets no clock')]);
  });

  it("grades nothing: a task with only criteria still says nothing is graded, and lint still fails it", () => {
    const { draft, domain } = domainOf(withMetrics("Is polite"));
    expect(domain.tasks[0]!.expect).toMatchObject({ state: [], called: [], not_called: [] });
    expect(draft.tasks[0]!.notes[0]).toBe("Nothing is graded yet: add the end state (expect.state) or the tools a correct call uses (expect.called).");
    expect(lintDomain(domain).tasks[0]!.errors).not.toEqual([]);
  });

  it("drafts one criterion for a text given twice, skips what isn't text, and adds no key with none", () => {
    expect(domainOf(withMetrics("Is polite", 7, "", " Is polite ", "Says goodbye")).domain.tasks[0]!.judged).toEqual([entry(1, "Is polite"), entry(2, "Says goodbye")]);
    expect(domainOf(withMetrics()).domain.tasks[0]).not.toHaveProperty("judged");
  });
});
