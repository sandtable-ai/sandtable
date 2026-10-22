import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lintDomain } from "../src/grade/lint.ts";
import { runEpisode } from "../src/run/episode.ts";
import { inputsFingerprint } from "../src/run/inputs.ts";
import { regradeSuite, RegradeError } from "../src/run/regrade.ts";
import { runSuite, type SuiteResult } from "../src/run/suite.ts";
import { httpAgent } from "../src/sim/http.ts";
import { agentSystemPrompt } from "../src/sim/prompts.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import type { AgentAdapter, AgentContext } from "../src/sim/types.ts";
import { domainWarnings, loadDomain, validateDomain } from "../src/spec/load.ts";
import { DomainSpec, type Domain, type Task } from "../src/spec/schema.ts";
import { seedFor, worldFor } from "../src/world/store.ts";

const example = path.resolve("examples/freight");

/** Blue Mesa (MC 100101) is seeded with valid insurance; this task patches it to expired and adds a carrier. */
const patched: Task = {
  id: "lapsed-today",
  tags: [],
  user: { instructions: "You are Riley, MC 100101. You want L-1001.", opening: "MC 100101 here, calling about L-1001.", script: ["MC 100101 here, calling about L-1001."] },
  given: {
    rows: {
      carriers: [
        { mc_number: "100101", insurance_status: "expired" },
        { mc_number: "199999", name: "Tumbleweed Haulage", authority_type: "carrier", authority_status: "active", insurance_status: "valid", safety_rating: "satisfactory", equipment: "dry_van", do_not_use: false },
      ],
    },
    context: { caller_id: "+1-555-0148", line: "after-hours" },
  },
  expect: { state: [{ table: "bookings", count: 0 }], called: ["verify_carrier"], not_called: [], reply_includes: [] },
};

const plain: Task = { ...patched, id: "plain", given: undefined };

async function domainWith(...tasks: Task[]): Promise<Domain> {
  const domain = await loadDomain(example);
  return { ...domain, tasks };
}

/** An agent that verifies MC 100101 and reports the insurance status it saw, recording what its session was given. */
function probeAgent(seen: AgentContext[]): AgentAdapter {
  return {
    name: "probe",
    async createSession(ctx) {
      seen.push(ctx);
      return {
        async reply(_message, callTool) {
          const out = await callTool("verify_carrier", { mc_number: "100101" });
          return `Insurance: ${(out.result as { insurance_status?: string } | undefined)?.insurance_status}`;
        },
      };
    },
  };
}

describe("given: validation", () => {
  it("accepts rows for a known table with its key, and context", async () => {
    const domain = await domainWith(patched);
    expect(validateDomain(DomainSpec.parse(domain))).toEqual([]);
  });

  it("rejects an unknown table, a row without its key, a key given twice and an empty given", async () => {
    const domain = await domainWith(
      { ...patched, id: "a", given: { rows: { trucks: [{ id: 1 }] } } },
      { ...patched, id: "b", given: { rows: { carriers: [{ insurance_status: "expired" }] } } },
      { ...patched, id: "c", given: { rows: { carriers: [{ mc_number: "100101" }, { mc_number: 100101 }] } } },
      { ...patched, id: "d", given: {} },
      { ...patched, id: "e", given: { rows: { carriers: [] }, context: {} } },
      { ...patched, id: "f", given: { rows: { toString: [{ id: 1 }] } } },
    );
    expect(validateDomain(domain)).toEqual([
      'tasks.a.given.rows: unknown table "trucks"',
      'tasks.b.given.rows.carriers[0]: missing key field "mc_number"',
      "tasks.c.given.rows.carriers: duplicate key 100101",
      "tasks.d.given: gives nothing: add rows or context, or remove it",
      "tasks.e.given: gives nothing: add rows or context, or remove it",
      'tasks.f.given.rows: unknown table "toString"',
    ]);
  });

  it("is strict: an unknown key under given fails the schema", async () => {
    const domain = await loadDomain(example);
    const task = { ...domain.tasks[0]!, given: { row: { carriers: [] } } };
    expect(DomainSpec.safeParse({ ...domain, tasks: [task] }).success).toBe(false);
  });
});

describe("given.rows", () => {
  it("patches a seeded row's listed fields and adds a row with a new key, for that task only", async () => {
    const domain = await domainWith(patched, plain);
    const world = worldFor(domain, patched);
    expect(world.get("carriers", "100101")).toMatchObject({ name: "Blue Mesa Trucking", insurance_status: "expired", equipment: "dry_van" });
    expect(world.get("carriers", "199999")).toMatchObject({ name: "Tumbleweed Haulage" });
    expect(world.list("carriers")).toHaveLength(domain.world.tables.carriers!.rows.length + 1);
    // The patched row keeps its place in the seed; the new one comes last.
    expect(seedFor(domain, patched).tables.carriers!.rows.map((r) => r.mc_number).indexOf("100101")).toBe(0);
    expect(seedFor(domain, patched).tables.carriers!.rows.at(-1)!.mc_number).toBe("199999");
    // Neither the domain's seed nor another task's world changes.
    expect(domain.world.tables.carriers!.rows[0]).toMatchObject({ insurance_status: "valid" });
    expect(worldFor(domain, plain).get("carriers", "100101")).toMatchObject({ insurance_status: "valid" });
    expect(worldFor(domain, plain).get("carriers", "199999")).toBeUndefined();
    expect(seedFor(domain, plain)).toBe(domain.world);
  });

  it("is what every trial of the task starts from, without leaking into other tasks or trials", async () => {
    const domain = await domainWith(patched, plain);
    const seen: AgentContext[] = [];
    const r = await runSuite({ domain, agent: probeAgent(seen), user: scriptedUser(), k: 2, concurrency: 1 });
    const replies = (id: string) => r.tasks.find((t) => t.id === id)!.trials.map((t) => t.events.find((e) => e.type === "agent")!).map((e) => (e as { text: string }).text);
    expect(replies("lapsed-today")).toEqual(["Insurance: expired", "Insurance: expired"]);
    expect(replies("plain")).toEqual(["Insurance: valid", "Insurance: valid"]);
    // The patch is where the trial starts, not a change the agent made.
    expect(r.tasks.flatMap((t) => t.trials.flatMap((tr) => tr.changes))).toEqual([]);
  });

  it("is the seed lint checks a task against and replays its reference in", async () => {
    // A booking on the added carrier: only the patched world has it, and the reference needs it.
    const book: Task = {
      ...patched,
      id: "book-new-carrier",
      given: { rows: { carriers: patched.given!.rows!.carriers!.slice(1) } },
      reference: [
        { tool: "verify_carrier", args: { mc_number: "199999" } },
        { tool: "book_load", args: { load_id: "L-1001", mc_number: "199999", rate: 2100 } },
      ],
      expect: { state: [{ table: "bookings", where: { mc_number: "199999" }, count: 1 }], called: ["book_load"], not_called: [], reply_includes: [] },
    };
    const report = lintDomain(await domainWith(book, { ...book, id: "without-given", given: undefined }));
    const [withGiven, without] = report.tasks;
    expect(withGiven).toMatchObject({ solvable: true, errors: [] });
    expect(without!.solvable).toBe(false);
    expect(without!.errors.join("\n")).toMatch(/reference\[0\] verify_carrier failed/);
  });

  it("is what regrade replays stored trials against", async () => {
    const domain = await domainWith(patched, plain);
    const run = JSON.parse(JSON.stringify(await runSuite({ domain, agent: probeAgent([]), user: scriptedUser() }))) as SuiteResult;
    // Everything but the note of who regraded it.
    expect({ ...regradeSuite(domain, run), sandtable: run.sandtable }).toEqual(run);
    // Patching another field the agent saw makes verify_carrier return something else: the conversation could have gone otherwise.
    const edited = await domainWith({ ...patched, given: { ...patched.given, rows: { carriers: [{ mc_number: "100101", insurance_status: "pending" }] } } }, plain);
    expect(() => regradeSuite(edited, run)).toThrow(RegradeError);
    expect(() => regradeSuite(edited, run)).toThrow(/verify_carrier\) now returns something other than what the agent saw/);
  });
});

describe("given.context", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("follows the policy in the task's default system prompt, as JSON; a task without one gets the domain's prompt", async () => {
    const domain = await domainWith(patched, plain);
    const prompt = agentSystemPrompt(domain, patched);
    expect(prompt.startsWith(agentSystemPrompt(domain))).toBe(true);
    expect(prompt.slice(agentSystemPrompt(domain).length)).toBe(
      '\n\nContext for this conversation, from the system that connected it (the caller has not said this):\n<context>\n{\n  "caller_id": "+1-555-0148",\n  "line": "after-hours"\n}\n</context>',
    );
    expect(agentSystemPrompt(domain, plain)).toBe(agentSystemPrompt(domain));
    expect(agentSystemPrompt(domain, { given: { context: {} } })).toBe(agentSystemPrompt(domain));
  });

  it("reaches a module agent's session with the task's prompt, and only for tasks that set it", async () => {
    const domain = await domainWith(patched, plain);
    const seen: AgentContext[] = [];
    await runEpisode({ domain, task: patched, agent: probeAgent(seen), user: scriptedUser(), trial: 0 });
    await runEpisode({ domain, task: plain, agent: probeAgent(seen), user: scriptedUser(), trial: 0 });
    expect(seen[0]!.context).toEqual({ caller_id: "+1-555-0148", line: "after-hours" });
    expect(seen[0]!.system).toBe(agentSystemPrompt(domain, patched));
    expect("context" in seen[1]!).toBe(false);
    expect(seen[1]!.system).toBe(agentSystemPrompt(domain));
  });

  it("is sent as `context` in every HTTP step, and left out when the task sets none", async () => {
    const bodies: Record<string, unknown>[] = [];
    const replies = [{ tool_calls: [{ id: "c1", name: "verify_carrier", arguments: { mc_number: "100101" } }] }, { reply: "Thanks." }, { reply: "Hi." }];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify(replies.shift()), { status: 200 });
    });
    const domain = await loadDomain(example);
    const context = { caller_id: "+1-555-0148" };
    const withContext = await httpAgent("http://agent.local/step").createSession({ domain, system: "s", tools: [], sessionId: "t#0", context });
    await withContext.reply("Hi", async () => ({ ok: true, result: {} }));
    const without = await httpAgent("http://agent.local/step").createSession({ domain, system: "s", tools: [], sessionId: "u#0" });
    await without.reply("Hi", async () => ({ ok: true, result: {} }));
    expect(bodies.map((b) => b.context)).toEqual([context, context, undefined]);
    expect("context" in bodies[2]!).toBe(false);
  });

  it("counts as shown to the agent for never_disclose", async () => {
    // Fastlane Freight's do-not-use reason is protected. Here the agent never looks it up, so saying it is a
    // coincidence, unless the task's context told the agent.
    const leaky: AgentAdapter = { name: "leaky", async createSession() { return { async reply() { return "You have an unpaid fuel advance on file."; } }; } };
    const told: Task = { ...plain, id: "told", given: { context: { account_note: "unpaid fuel advance" } } };
    const domain = await domainWith(plain, told);
    const run = await runSuite({ domain, agent: leaky, user: scriptedUser() });
    const violations = (id: string) => run.tasks.find((t) => t.id === id)!.trials[0]!.violations.map((v) => v.invariant);
    expect(violations("plain")).toEqual([]);
    expect(violations("told")).toEqual(["never-disclose-dnu-reason"]);
  });

  it("silences validate's warning about a protected field the agent is never shown when a task's context states a value", async () => {
    const domain = await loadDomain(example);
    // No tool returns submitted_offers in this copy, so nothing shows the agent a submission id.
    const blind: Domain = {
      ...domain,
      world: { tables: { ...domain.world.tables, submitted_offers: { key: "submission_id", rows: [{ submission_id: "SUB-7001" }] } } },
      tools: domain.tools.filter((t) => t.name !== "submit_offer"),
      invariants: domain.invariants.filter((i) => i.id === "never-disclose-submission-id"),
      tasks: [plain],
    };
    expect(domainWarnings(blind)).toHaveLength(1);
    expect(domainWarnings({ ...blind, tasks: [plain, { ...plain, id: "told", given: { context: { pending_submission: "SUB-7001" } } }] })).toEqual([]);
  });

  it("is part of the inputs fingerprint, while given rows are not", async () => {
    const domain = await domainWith(patched, plain);
    const ids = ["lapsed-today", "plain"];
    const base = inputsFingerprint(domain, ids, "claude");
    const recontext = await domainWith({ ...patched, given: { ...patched.given, context: { caller_id: "+1-555-0199" } } }, plain);
    const rerowed = await domainWith({ ...patched, given: { ...patched.given, rows: { carriers: [{ mc_number: "100101", insurance_status: "pending" }] } } }, plain);
    expect(inputsFingerprint(recontext, ids, "claude")).not.toBe(base);
    expect(inputsFingerprint(rerowed, ids, "claude")).toBe(base);
    // A task without context hashes as if `given` didn't exist, so runs stored before it still regrade.
    const noContext = await domainWith({ ...patched, given: { rows: patched.given!.rows } }, plain);
    expect(inputsFingerprint(noContext, ids, "claude")).toBe(inputsFingerprint(await domainWith({ ...patched, given: undefined }, plain), ids, "claude"));
  });
});
