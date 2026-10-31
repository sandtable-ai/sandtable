import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { draftFromVapi, renderVapiDraft, vapiProblem, type VapiFile } from "../src/init/vapi.ts";
import { lintDomain } from "../src/grade/lint.ts";
import { runSuite } from "../src/run/suite.ts";
import { noopAgent } from "../src/sim/noop.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import { loadDomain, parseDomain, pendingReview } from "../src/spec/load.ts";

// sandtable import vapi (#34): a draft domain from a Vapi assistant's config, its tools and its simulation scenarios.

const run = promisify(execFile);
const cli = path.resolve("src/cli.ts");
const example = path.resolve("examples/vapi");

const assistant = (extra: Record<string, unknown> = {}, model: Record<string, unknown> = {}) => ({
  name: "Desk",
  model: { provider: "openai", model: "gpt-4o", messages: [{ role: "system", content: "Be helpful." }], ...model },
  ...extra,
});
const fn = (name: string, properties: Record<string, unknown> = {}, required: string[] = [], extra: Record<string, unknown> = {}) => ({
  type: "function",
  function: { name, description: `${name} does it`, parameters: { type: "object", properties, required } },
  ...extra,
});
const files = (...items: [string, unknown][]): VapiFile[] => items.map(([file, json]) => ({ file, json }));

/** The draft as the domain its files make, parsed and cross-checked as a loaded one is. */
function domainOf(f: VapiFile[]) {
  const d = draftFromVapi(f);
  const r = renderVapiDraft(d);
  return { draft: d, domain: parseDomain({ ...YAML.parse(r.domain), policy: d.policy, tasks: YAML.parse(r.tasks) }) };
}

describe("import vapi: the bundled example", () => {
  it.skipIf(!process.features.typescript)("imports, validates and runs with the scripted user from the CLI", { timeout: 30_000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-import-"));
    const out = path.join(dir, "pinecrest");
    const imported = await run(process.execPath, [cli, "import", "vapi", example, "-o", out]);
    expect(imported.stdout).toContain("Imported pinecrest-bike-repair from Vapi: 4 tools, 2 tables, 2 tasks, all pending review.");
    expect(imported.stdout).toContain("{{customer_phone}}");
    expect(imported.stdout).toContain(`npx sandtable-ai init --sop ${path.join(out, "policy.md")} -o ${out} --dry-run`);
    const domain = await loadDomain(out);
    expect(domain.tools.map((t) => t.name)).toEqual(["get_repair", "transferCall", "endCall", "book_service"]);
    expect(domain.policy).toMatch(/^# Pinecrest Bike Repair\n\nYou are the phone assistant for Pinecrest Bike Repair/);
    expect(domain.policy).toContain('Open each call with: "Thanks for calling Pinecrest Bike Repair, this is the service desk. How can I help?"');
    expect(domain.tools.find((t) => t.name === "get_repair")).toMatchObject({ params: { ticket_id: { type: "string", required: true } }, ops: [{ get: "get_repair_results", key: "$ticket_id" }], review: "pending" });
    expect(domain.tools.find((t) => t.name === "book_service")).toMatchObject({ params: { service: { enum: ["tune_up", "flat_fix", "brake_service"] } }, ops: [{ respond: "Booked: tune-up for Riley Chen on 2026-11-12, confirmation PB-77" }] });
    expect(domain.tools.find((t) => t.name === "transferCall")!.params.destination!.enum).toEqual(["+15555550100"]);
    const ready = domain.tasks.find((t) => t.id === "repair-status-for-a-bike-that-s-ready")!;
    expect(ready).toMatchObject({
      review: "pending",
      source: { file: path.join("scenarios", "repair-ready.json") },
      user: { opening: "Hi.", script: ["Hi."] },
      given: { rows: { get_repair_results: [{ ticket_id: "R-2041", status: "ready", balance_due: 85 }] }, context: { customer_phone: "+15555550142" } },
      expect: { called: ["get_repair"] },
    });
    expect(pendingReview(domain).length).toBe(5);
    const tasksYaml = await readFile(path.join(out, "tasks.yaml"), "utf8");
    expect(tasksYaml).toContain("# TODO(review): Vapi graded it with so-told-ready-and-balance = true");
    // Validate passes; --strict fails while the drafts are pending.
    expect((await run(process.execPath, [cli, "validate", out])).stdout).toContain("2 tables, 4 tools, 0 invariants, 2 tasks");
    expect(await run(process.execPath, [cli, "validate", out, "--strict"]).catch((e: { code: number }) => e)).toMatchObject({ code: 1 });
    // It runs with the scripted user: the do-nothing agent fails both, since each scenario mocked a tool to call.
    const r = await runSuite({ domain, agent: noopAgent(), user: scriptedUser() });
    expect(r.tasks.map((t) => [t.id, t.passes, t.trials[0]!.checks.filter((c) => !c.passed).map((c) => c.id)])).toEqual([
      ["book-a-tune-up", 0, ["called:book_service"]],
      ["repair-status-for-a-bike-that-s-ready", 0, ["called:get_repair"]],
    ]);
    expect(lintDomain(domain).errors).toBe(0);
    // A second import stops before it overwrites anything, unless --force.
    expect(await run(process.execPath, [cli, "import", "vapi", example, "-o", out]).catch((e: { code: number; stderr: string }) => e)).toMatchObject({ code: 2, stderr: expect.stringContaining("refusing to overwrite") });
    expect((await run(process.execPath, [cli, "import", "vapi", example, "-o", out, "--force"])).stdout).toContain("Imported");
  });

  it.skipIf(!process.features.typescript)("refuses an unknown platform, an export with no assistant or two, and a file that isn't JSON, writing nothing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-import-bad-"));
    const fail = (...args: string[]) => run(process.execPath, [cli, ...args]).catch((e: { code: number; stderr: string }) => e);
    expect(await fail("import", "retell", example, "-o", path.join(dir, "x"))).toMatchObject({ code: 2, stderr: expect.stringContaining('unknown platform "retell": import supports vapi') });
    await writeFile(path.join(dir, "tool.json"), JSON.stringify(fn("x")));
    expect(await fail("import", "vapi", path.join(dir, "tool.json"), "-o", path.join(dir, "out"))).toMatchObject({ code: 2, stderr: expect.stringContaining("has no Vapi assistant") });
    await writeFile(path.join(dir, "two.json"), JSON.stringify([assistant({ name: "A" }), assistant({ name: "B" })]));
    expect(await fail("import", "vapi", path.join(dir, "two.json"), "-o", path.join(dir, "out"))).toMatchObject({ code: 2, stderr: expect.stringContaining("has 2 assistants (A, B): import one at a time") });
    await writeFile(path.join(dir, "bad.json"), "{nope");
    expect(await fail("import", "vapi", path.join(dir, "bad.json"), "-o", path.join(dir, "out"))).toMatchObject({ code: 2, stderr: expect.stringContaining("bad.json is not JSON") });
    expect(await fail("import", "vapi", path.join(dir, "missing.json"))).toMatchObject({ code: 2 });
  });
});

describe("import vapi: mapping", () => {
  it("takes inline tools and the toolIds the export has, and says what it skipped", () => {
    const d = draftFromVapi(
      files(
        ["a.json", assistant({}, { tools: [fn("look up!", { id: { type: "string" } }, ["id"]), { type: "dtmf" }, { type: "endCall" }], toolIds: ["t1", "t-missing"] })],
        ["t1.json", { id: "t1", ...fn("book", { when: { type: "string" }, n: { type: "integer" }, notes: { type: ["string", "number"] } }, ["when"]) }],
        ["t2.json", { id: "t2", ...fn("unused") }],
        ["junk.json", { hello: 1 }],
      ),
    );
    expect(d.tools.map((t) => t.name)).toEqual(["look_up", "endCall", "book"]);
    expect(d.tools[2]!.params).toEqual({ when: { type: "string", required: true }, n: { type: "integer", required: false } });
    expect(d.tools[2]!.notes).toContain('Parameter "notes" has a schema the draft can\'t map, so it was left out: add it by hand.');
    expect(d.warnings).toEqual([
      "junk.json: not a Vapi assistant (with model), tool (with type) or simulation scenario (with instructions); skipped",
      "model.toolIds names t-missing, which no file in the export has: add it with GET https://api.vapi.ai/tool/t-missing",
      "t2.json: a tool the assistant doesn't use (it isn't in model.toolIds); skipped",
      'a.json: function "look up!" is tool "look_up": tool names match ^[a-zA-Z0-9_-]{1,64}$',
      "a.json: a dtmf tool, which Vapi runs itself, has no sandtable counterpart; skipped",
    ]);
  });

  it("lifts each scenario's tool mocks into that task's rows, keyed by a param the records have, else by a made-up id", () => {
    const tools = [fn("get_order", { order_id: { type: "string" } }, ["order_id"]), fn("list_slots", { day: { type: "string" } }, ["day"]), fn("note", { text: { type: "string" } }, ["text"])];
    const scenario = (name: string, toolMocks: unknown[], extra: Record<string, unknown> = {}) => ({ name, instructions: `You are ${name}.`, toolMocks, ...extra });
    const { draft, domain } = domainOf(
      files(
        ["a.json", assistant({}, { tools })],
        ["s1.json", scenario("Shipped order", [{ toolName: "get_order", result: '{"order_id":"A1","status":"shipped"}' }, { toolName: "list_slots", result: [{ time: "9:00" }, { time: "10:00" }] }])],
        ["s2.json", scenario("Lost order", [{ toolName: "get_order", result: { order_id: "B2", status: "lost" } }, { toolName: "note", result: "Saved." }, { toolName: "ghost", result: "x" }, { toolName: "note", result: "nope", enabled: false }])],
        ["s3.json", scenario("Other note", [{ toolName: "note", result: "Saved, but differently." }])],
      ),
    );
    expect(draft.tables).toEqual({ get_order_results: { key: "order_id" }, list_slots_results: { key: "id" } });
    expect(domain.tools.find((t) => t.name === "get_order")!.ops).toEqual([{ get: "get_order_results", key: "$order_id" }]);
    expect(domain.tools.find((t) => t.name === "list_slots")!.ops).toEqual([{ list: "list_slots_results" }]);
    expect(domain.tools.find((t) => t.name === "note")!.ops).toEqual([{ respond: "Saved." }]);
    const [shipped, lost, other] = domain.tasks;
    expect(shipped!.given!.rows).toEqual({ get_order_results: [{ order_id: "A1", status: "shipped" }], list_slots_results: [{ id: "shipped-order-1", time: "9:00" }, { id: "shipped-order-2", time: "10:00" }] });
    expect(lost!.given!.rows).toEqual({ get_order_results: [{ order_id: "B2", status: "lost" }] });
    expect(shipped!.expect.called).toEqual(["get_order", "list_slots"]);
    expect(lost!.expect.called).toEqual(["get_order", "note"]);
    expect(draft.tasks[2]!.notes[0]).toMatch(/Its mock of note answers with other text/);
    expect(other!.expect.called).toEqual(["note"]);
    expect(draft.warnings).toEqual(["s2.json: a tool mock for ghost, which the assistant doesn't have; skipped"]);
    // The draft is a valid domain, and each task's rows are what its own scenario mocked.
    expect(lintDomain(domain).tasks.every((t) => t.ready)).toBe(true);
  });

  it("drafts a placeholder policy without a system message, and a task with nothing to grade says so", () => {
    const { draft, domain } = domainOf(files(["a.json", { name: "Quiet", model: { provider: "openai", tools: [{ type: "endCall" }] } }], ["s.json", { name: "Chat", instructions: "Say hi." }]));
    expect(draft.policy).toMatch(/^# Policy\n\nTODO/);
    expect(draft.warnings).toContain("a.json: the assistant has no system message, so policy.md is a placeholder");
    expect(domain.tasks[0]!.expect).toMatchObject({ state: [], called: [] });
    expect(draft.tasks[0]!.notes[0]).toBe("Nothing is graded yet: add the end state (expect.state) or the tools a correct call uses (expect.called).");
  });

  it.skipIf(!process.features.typescript)("refuses an assistant with no tool it can model, since a domain needs one", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-import-notools-"));
    await writeFile(path.join(dir, "a.json"), JSON.stringify(assistant({}, { tools: [{ type: "dtmf" }] })));
    const r = await run(process.execPath, [cli, "import", "vapi", path.join(dir, "a.json"), "-o", path.join(dir, "out")]).catch((e: { code: number; stderr: string }) => e);
    expect(r).toMatchObject({ code: 2, stderr: expect.stringContaining("the assistant has no tool sandtable can model, and a domain needs one") });
    expect((r as { stderr: string }).stderr).toContain("a dtmf tool, which Vapi runs itself, has no sandtable counterpart; skipped");
  });

  it("matches a mock to a renamed tool, skips a mock with no result, and notes params it can't type or name", () => {
    const tools = [
      fn("Get Slots!", { day: { type: "string" }, either: { anyOf: [{ type: "string" }, { type: "number" }] }, ref: { $ref: "#/x" }, loose: {}, "Mixed Case": { type: "string" } }, ["day"]),
      { type: "apiRequest" },
    ];
    const { draft, domain } = domainOf(
      files(
        ["a.json", assistant({}, { tools })],
        ["s.json", { name: "Slots", instructions: "Ask.", variableValues: { tier: "gold" }, toolMocks: [{ toolName: "Get Slots!", result: { day: "Mon", open: 3 } }, { toolName: "Get Slots!" }, { toolName: "Get Slots!", result: "x", enabled: false }], evaluations: [{ structuredOutputId: "so-a" }] }],
      ),
    );
    const slots = domain.tools.find((t) => t.name === "get_slots")!;
    expect(slots.ops).toEqual([{ get: "get_slots_results", key: "$day" }]);
    expect(Object.keys(slots.params)).toEqual(["day", "loose", "Mixed Case"]);
    const notes = draft.tools[0]!.notes;
    expect(notes[0]).toMatch(/^Drafted from the tool mocks/);
    expect(notes).toEqual(
      expect.arrayContaining([
        'Parameter "either" has a schema the draft can\'t map, so it was left out: add it by hand.',
        'Parameter "ref" has a schema the draft can\'t map, so it was left out: add it by hand.',
        'Parameter "loose" has no type in the Vapi config, so it was drafted as a string: check it.',
        'Parameter "Mixed Case" has a name model APIs reject (they take ^[a-zA-Z0-9_.-]{1,64}$): rename it here and in the agent\'s tool.',
      ]),
    );
    expect(draft.warnings).toContain("s.json: the tool mock for Get Slots! has no result; skipped");
    expect(draft.warnings).toContain("a.json: an apiRequest tool, which Vapi runs itself, has no sandtable counterpart; skipped");
    expect(domain.tasks[0]!.given).toMatchObject({ rows: { get_slots_results: [{ day: "Mon", open: 3 }] }, context: { tier: "gold" } });
    expect(draft.tasks[0]!.notes).toContain("Its scenario's mock of Get Slots! is disabled, so it was left out.");
    expect(draft.tasks[0]!.notes).toContain("Vapi graded it with so-a: write that as expect.state, called or not_called, which sandtable grades without a model.");
  });

  it("says why it can't import", () => {
    expect(vapiProblem(files(["t.json", fn("x")]))).toMatch(/has no Vapi assistant/);
    expect(vapiProblem(files(["a.json", assistant()]))).toBeUndefined();
  });
});
