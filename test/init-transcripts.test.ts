import { cp, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { freightScriptedAgent } from "../src/demo/freight-agents.ts";
import { appendRows, appendToDomainList } from "../src/init/merge.ts";
import { lintDomain } from "../src/grade/lint.ts";
import { copiedValueNotes } from "../src/init/copied.ts";
import { draftTasksFromTranscripts, reusedRowConflicts, scrubPii } from "../src/init/transcripts.ts";
import { runSuite } from "../src/run/suite.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import { DOMAIN_FILE, loadDomain, pendingReview } from "../src/spec/load.ts";

const good = {
  id: "negotiate-new-lane",
  description: "Vetted carrier negotiates a Dallas to Atlanta load and settles under the ceiling.",
  quote: "Twenty-three and you've got a truck.",
  tags: ["negotiation"],
  persona_id: "veteran-dispatcher",
  new_persona: { id: "veteran-dispatcher", description: "A long-time dispatcher who counters every offer once." },
  instructions: "You are Dana at Blue Mesa Trucking, MC 100101. You want L-2001. Ask for $2,600; accept $2,250 or more.",
  script: ["Hi, MC 100101, Blue Mesa. Looking at L-2001 Dallas to Atlanta.", "I need $2,600.", "How about $2,300?", "Deal, book it.", "Thanks."],
  new_rows: [
    {
      table: "loads",
      fields: [
        { name: "load_id", value: "L-2001" },
        { name: "origin", value: "Dallas, TX" },
        { name: "destination", value: "Atlanta, GA" },
        { name: "pickup_date", value: "2026-11-10" },
        { name: "equipment", value: "dry_van" },
        { name: "weight_lbs", value: 40000 },
        { name: "posted_rate", value: 2100 },
        { name: "max_rate", value: 2400 },
        { name: "status", value: "available" },
      ],
    },
  ],
  expect_state: [
    {
      table: "bookings",
      conditions: [
        { field: "load_id", op: "eq", value: "L-2001" },
        { field: "mc_number", op: "eq", value: "100101" },
        { field: "rate", op: "gte", value: 2250 },
        { field: "rate", op: "lte", value: 2400 },
      ],
      count: 1,
    },
  ],
  expect_called: ["verify_carrier", "book_load"],
  expect_not_called: [],
};
const collides = { ...good, id: "dup-row", new_persona: null, persona_id: "easygoing", new_rows: [{ table: "loads", fields: [{ name: "load_id", value: "L-1001" }] }] };
const ungraded = { ...good, id: "nothing-to-grade", new_persona: null, persona_id: "easygoing", new_rows: [], expect_state: [], expect_called: [] };

// A later transcript about a carrier with the same name as a seeded one, but lapsed insurance and a reefer.
const lapsed = {
  ...good,
  id: "lapsed-insurance-same-name",
  description: "A carrier whose insurance lapsed asks for a load; the agent declines.",
  new_persona: null,
  persona_id: "easygoing",
  instructions: "You are Rowan at Blue Mesa Trucking. Your insurance lapsed last week. You run a reefer and want L-1001.",
  new_rows: [],
  expect_state: [{ table: "bookings", conditions: [{ field: "load_id", op: "eq", value: "L-1001" }], count: 0 }],
  expect_called: ["verify_carrier"],
  expect_not_called: ["book_load"],
};
// The model reused the seeded carrier, whose insurance is valid and who runs a dry van.
const reusesConflicting = {
  ...lapsed,
  existing_rows: [
    {
      table: "carriers",
      key: "100101",
      facts: [
        { name: "name", value: "Blue Mesa Trucking" },
        { name: "insurance_status", value: "expired" },
        { name: "equipment", value: "reefer" },
      ],
    },
  ],
};
// The model kept the transcript's facts: a new carrier with new identifiers.
const newRowInstead = {
  ...lapsed,
  id: "lapsed-insurance-new-carrier",
  instructions: "You are Rowan at Blue Mesa Freight, MC 104242. Your insurance lapsed last week. You run a reefer and want L-1001.",
  new_rows: [
    {
      table: "carriers",
      fields: [
        { name: "mc_number", value: "104242" },
        { name: "name", value: "Blue Mesa Freight" },
        { name: "authority_type", value: "carrier" },
        { name: "authority_status", value: "active" },
        { name: "insurance_status", value: "expired" },
        { name: "safety_rating", value: "satisfactory" },
        { name: "equipment", value: "reefer" },
        { name: "do_not_use", value: false },
      ],
    },
  ],
  existing_rows: [],
};
// A reuse whose facts all match the row, up to case; a field the row doesn't have is not a conflict.
const reusesMatching = {
  ...good,
  existing_rows: [
    {
      table: "carriers",
      key: "100101",
      facts: [
        { name: "insurance_status", value: "VALID" },
        { name: "authority_status", value: "Active" },
        { name: "preferred_lane", value: "Dallas to Atlanta" },
      ],
    },
  ],
};

// The calls a correct agent makes: vet the carrier, then book within the expected range.
const args = (o: Record<string, unknown>) => Object.entries(o).map(([name, value]) => ({ name, value }));
const withReference = {
  ...good,
  reference: [
    { tool: "verify_carrier", args: args({ mc_number: "100101" }) },
    { tool: "book_load", args: args({ load_id: "L-2001", mc_number: "100101", rate: 2300 }) },
  ],
};
// A later draft on the same load whose reference books below the range its own expectation asks for.
const referenceMisses = {
  ...withReference,
  id: "negotiate-reference-misses",
  new_persona: null,
  persona_id: "easygoing",
  new_rows: [],
  reference: [
    { tool: "verify_carrier", args: args({ mc_number: "100101" }) },
    { tool: "book_load", args: args({ load_id: "L-2001", mc_number: "100101", rate: 2200 }) },
  ],
};

// The reference spells an equipment type as the caller said it, not as the API's enum writes it.
const spelledLikeTheCall = {
  ...withReference,
  reference: [
    { tool: "verify_carrier", args: args({ mc_number: "100101" }) },
    { tool: "search_loads", args: args({ origin: "Dallas", equipment: "Dry Van" }) },
    { tool: "book_load", args: args({ load_id: "L-2001", mc_number: "100101", rate: 2300 }) },
  ],
};
// A value that matches no allowed one, in any spelling.
const noSuchValue = {
  ...spelledLikeTheCall,
  reference: [
    { tool: "verify_carrier", args: args({ mc_number: "100101" }) },
    { tool: "search_loads", args: args({ origin: "Dallas", equipment: "Box Truck" }) },
    { tool: "book_load", args: args({ load_id: "L-2001", mc_number: "100101", rate: 2300 }) },
  ],
};
// A refusal whose end state allows either of two statuses, and a field that must stay unset.
const withInAndExists = {
  ...lapsed,
  id: "load-stays-open",
  expect_state: [
    {
      table: "loads",
      conditions: [
        { field: "load_id", op: "eq", value: "L-1001" },
        { field: "status", op: "in", value: ["available", "pending"] },
        { field: "booked_by", op: "exists", value: false },
      ],
      count: 1,
    },
  ],
};

function fakeClient(outputs: unknown[]) {
  const requests: Array<{ system: string; messages: Array<{ content: string }> }> = [];
  const client = {
    beta: {
      messages: {
        parse: async (req: { system: string; messages: Array<{ content: string }> }) => {
          requests.push(req);
          return { stop_reason: "end_turn", parsed_output: outputs.shift(), content: [] };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, requests };
}

describe("PII scrub", () => {
  it("removes emails, phones and card numbers but keeps short identifiers", () => {
    const { text, redactions } = scrubPii(
      "Email dana@bluemesa.example or call (214) 555-0199. Card 4111 1111 1111 1111. MC 4-4-1-2-0-9, MC 441209, load L-1001, $2,275.",
    );
    expect(text).toBe("Email [email] or call [phone]. Card [card]. MC 4-4-1-2-0-9, MC 441209, load L-1001, $2,275.");
    expect(redactions).toBe(3);
  });
});

describe("init from transcripts", () => {
  it("drafts grounded tasks, scrubs before sending, and explains drops", async () => {
    const domain = await loadDomain(path.resolve("examples/freight"));
    const { client, requests } = fakeClient([good, collides, ungraded]);
    const res = await draftTasksFromTranscripts({
      domain,
      claude: { client },
      transcripts: [
        { file: "call-1.txt", text: "REP: Hi. CALLER: reach me at dana@bluemesa.example. Twenty-three and you've got a truck." },
        { file: "call-2.txt", text: "..." },
        { file: "call-3.txt", text: "..." },
      ],
    });
    expect(requests[0]!.messages[0]!.content).not.toContain("dana@bluemesa.example");
    expect(requests[0]!.messages[0]!.content).toContain("<policy>");
    expect(res.redactions).toBe(1);
    expect(res.tasks.map((t) => t.id)).toEqual(["negotiate-new-lane"]);
    expect(res.tasks[0]).toMatchObject({ review: "pending", source: { file: "call-1.txt" }, user: { script: good.script } });
    // Both bounds of the negotiated range are kept.
    expect(res.tasks[0]!.expect.state[0]!.where).toEqual({ load_id: "L-2001", mc_number: "100101", rate: { $gte: 2250, $lte: 2400 } });
    expect(res.personas.map((p) => p.id)).toEqual(["veteran-dispatcher"]);
    expect(res.rows.loads).toHaveLength(1);
    expect(res.warnings).toEqual([
      // The chat's email was dana@…: its local part is the caller's name, which the draft kept.
      "call-1.txt: negotiate-new-lane: 1 value(s) copied from the chat: see its TODO(review) notes",
      "call-2.txt: dropped dup-row: new loads row L-1001 collides with an existing row",
      "call-3.txt: dropped: no state or called expectations: nothing would be graded",
    ]);
  });

  it("merges rows, personas and tasks into a domain that runs offline", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-tx-"));
    await cp(path.resolve("examples/freight"), dir, { recursive: true });
    const { client } = fakeClient([good]);
    const res = await draftTasksFromTranscripts({ domain: await loadDomain(dir), claude: { client }, transcripts: [{ file: "call-1.txt", text: "..." }] });

    await appendRows(dir, res.rows);
    await appendToDomainList(dir, "personas", res.personas);
    await appendToDomainList(dir, "tasks", res.tasks);
    expect(await readFile(path.join(dir, DOMAIN_FILE), "utf8")).toContain("- { load_id: L-2001, origin: \"Dallas, TX\"");

    const domain = await loadDomain(dir);
    expect(pendingReview(domain).map((p) => p.id)).toEqual(["negotiate-new-lane"]);
    const r = await runSuite({ domain, agent: freightScriptedAgent("careful"), user: scriptedUser(), taskIds: ["negotiate-new-lane"] });
    expect(r.tasks[0]!.passes).toBe(1);
  });

  it("tells the model to keep a transcript's facts instead of fitting them to an existing row", async () => {
    const { client, requests } = fakeClient([good]);
    await draftTasksFromTranscripts({ domain: await loadDomain(path.resolve("examples/freight")), claude: { client }, transcripts: [{ file: "call-1.txt", text: "..." }] });
    expect(requests[0]!.system).toContain("Reuse an existing row only when every fact the transcript states about it matches the row");
    expect(requests[0]!.system).toContain("Never change what the transcript says to fit an existing row");
  });

  it("warns, and notes on the task, when a reused row contradicts the transcript", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-tx-"));
    await cp(path.resolve("examples/freight"), dir, { recursive: true });
    const { client } = fakeClient([reusesConflicting]);
    const res = await draftTasksFromTranscripts({ domain: await loadDomain(dir), claude: { client }, transcripts: [{ file: "call-7.txt", text: "..." }] });

    // The task is kept for review, with the conflict named: the row, each field, both values.
    expect(res.tasks.map((t) => t.id)).toEqual(["lapsed-insurance-same-name"]);
    expect(res.warnings).toEqual([
      'call-7.txt: lapsed-insurance-same-name reuses carriers 100101, but the transcript states insurance_status "expired" where the row has "valid", and equipment "reefer" where the row has "dry_van": keep the transcript\'s facts by giving the task its own row with new IDs, or correct the task',
    ]);
    await appendToDomainList(dir, "tasks", res.tasks, undefined, res.notes);
    const tasks = await readFile(path.join(dir, "tasks.yaml"), "utf8");
    expect(tasks).toContain(
      '# TODO(review): Reuses carriers 100101, but the transcript states insurance_status "expired" where the row has "valid", and equipment "reefer" where the row has "dry_van". Keep the transcript\'s facts: give this task its own row with new IDs, or correct the task.\n- id: lapsed-insurance-same-name',
    );
  });

  it("drafts a new row without a warning when the transcript's facts differ, and accepts a reuse whose facts match", async () => {
    const domain = await loadDomain(path.resolve("examples/freight"));
    const { client } = fakeClient([newRowInstead, reusesMatching]);
    const res = await draftTasksFromTranscripts({ domain, claude: { client }, transcripts: [{ file: "call-7.txt", text: "..." }, { file: "call-8.txt", text: "..." }] });
    expect(res.tasks.map((t) => t.id)).toEqual(["lapsed-insurance-new-carrier", "negotiate-new-lane"]);
    expect(res.rows.carriers).toEqual([expect.objectContaining({ mc_number: "104242", insurance_status: "expired" })]);
    expect(res.warnings).toEqual([]);
    expect(res.notes).toEqual({});
  });

  it("drafts reference calls, and keeps a task whose reference fails lint with a warning and a review note", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-tx-"));
    await cp(path.resolve("examples/freight"), dir, { recursive: true });
    const { client, requests } = fakeClient([withReference, referenceMisses]);
    const res = await draftTasksFromTranscripts({ domain: await loadDomain(dir), claude: { client }, transcripts: [{ file: "call-1.txt", text: "..." }, { file: "call-2.txt", text: "..." }] });

    expect(requests[0]!.system).toContain("as reference, the tool calls a correct agent makes when it follows the policy");
    expect(requests[0]!.system).toContain("list only calls that succeed");
    expect(res.tasks.map((t) => t.id)).toEqual(["negotiate-new-lane", "negotiate-reference-misses"]);
    expect(res.tasks[0]!.reference).toEqual([
      { tool: "verify_carrier", args: { mc_number: "100101" } },
      { tool: "book_load", args: { load_id: "L-2001", mc_number: "100101", rate: 2300 } },
    ]);
    expect(res.warnings).toEqual([expect.stringMatching(/^call-2\.txt: negotiate-reference-misses: reference does not pass: state:bookings#1: 0 bookings row\(s\) match/)]);
    expect(Object.keys(res.notes)).toEqual(["negotiate-reference-misses"]);
    expect(res.notes["negotiate-reference-misses"]![0]).toMatch(/^lint: reference does not pass: state:bookings#1: .*\. Fix the expectation, the seed rows or the reference\.$/);

    await appendRows(dir, res.rows);
    await appendToDomainList(dir, "personas", res.personas);
    await appendToDomainList(dir, "tasks", res.tasks, undefined, res.notes);
    expect(await readFile(path.join(dir, "tasks.yaml"), "utf8")).toContain("# TODO(review): lint: reference does not pass: state:bookings#1");
    const lint = lintDomain(await loadDomain(dir));
    expect(lint.tasks.find((t) => t.id === "negotiate-new-lane")).toMatchObject({ solvable: true, errors: [] });
    expect(lint.tasks.find((t) => t.id === "negotiate-reference-misses")).toMatchObject({ solvable: false });
  });

  it("leaves reference out when the draft proposes none", async () => {
    const domain = await loadDomain(path.resolve("examples/freight"));
    const { client } = fakeClient([{ ...good, reference: [] }]);
    const res = await draftTasksFromTranscripts({ domain, claude: { client }, transcripts: [{ file: "call-1.txt", text: "..." }] });
    expect(res.tasks[0]!.reference).toBeUndefined();
    expect(res.warnings).toEqual([]);
  });

  it("says when a listed existing row isn't in the world", async () => {
    const domain = await loadDomain(path.resolve("examples/freight"));
    expect(reusedRowConflicts(domain, [{ table: "carriers", key: "100999", facts: [] }])).toEqual(["lists carriers 100999 as an existing row, but there is none"]);
    // A key YAML read as a number still finds its row.
    expect(reusedRowConflicts(domain, [{ table: "carriers", key: "100101", facts: [{ name: "safety_rating", value: "satisfactory" }] }])).toEqual([]);
  });

  it("shows the model each param's allowed values, optional params and descriptions", async () => {
    const { client, requests } = fakeClient([good]);
    await draftTasksFromTranscripts({ domain: await loadDomain(path.resolve("examples/freight")), claude: { client }, transcripts: [{ file: "call-1.txt", text: "..." }] });
    const prompt = requests[0]!.messages[0]!.content;
    expect(prompt).toContain("- search_loads(origin: string, destination?: string, equipment?: string (dry_van|reefer|flatbed), pickup_from?: string, pickup_to?: string)");
    expect(prompt).toContain("\n    pickup_from: Earliest pickup date, YYYY-MM-DD");
    expect(prompt).toContain("A param marked ? is optional. One with values in parentheses takes exactly one of them, as written.");
    expect(requests[0]!.system).toContain('map the transcript\'s wording to it ("By Mail" is by_mail)');
  });

  it("fixes a reference value spelled as the caller said it, when it plainly means one allowed value", async () => {
    const domain = await loadDomain(path.resolve("examples/freight"));
    const { client } = fakeClient([spelledLikeTheCall]);
    const res = await draftTasksFromTranscripts({ domain, claude: { client }, transcripts: [{ file: "call-1.txt", text: "..." }] });
    expect(res.tasks[0]!.reference![1]).toEqual({ tool: "search_loads", args: { origin: "Dallas", equipment: "dry_van" } });
    expect(res.warnings).toEqual(['call-1.txt: negotiate-new-lane: reference[1] search_loads equipment "Dry Van" → dry_van']);
    expect(res.notes).toEqual({});
  });

  it("keeps a value that matches no allowed value, or several, for review", async () => {
    const domain = await loadDomain(path.resolve("examples/freight"));
    const { client } = fakeClient([noSuchValue]);
    const res = await draftTasksFromTranscripts({ domain, claude: { client }, transcripts: [{ file: "call-1.txt", text: "..." }] });
    expect(res.tasks[0]!.reference![1]!.args).toEqual({ origin: "Dallas", equipment: "Box Truck" });
    expect(res.warnings).toEqual([expect.stringMatching(/^call-1\.txt: negotiate-new-lane: reference\[1\] search_loads: invalid arguments: argument "equipment" must be one of dry_van, reefer, flatbed$/)]);
    expect(res.notes["negotiate-new-lane"]).toEqual([expect.stringMatching(/^lint: reference\[1\] search_loads: invalid arguments: .*\. Fix the expectation, the seed rows or the reference\.$/)]);

    // Two allowed values that read the same: the draft can't tell which one the caller meant.
    const twoSpellings = structuredClone(domain);
    twoSpellings.tools.find((t) => t.name === "search_loads")!.params.equipment!.enum = ["dry_van", "dry-van", "reefer"];
    const { client: client2 } = fakeClient([spelledLikeTheCall]);
    const res2 = await draftTasksFromTranscripts({ domain: twoSpellings, claude: { client: client2 }, transcripts: [{ file: "call-1.txt", text: "..." }] });
    expect(res2.tasks[0]!.reference![1]!.args).toEqual({ origin: "Dallas", equipment: "Dry Van" });
    expect(res2.warnings.some((w) => w.includes("→"))).toBe(false);
    expect(Object.keys(res2.notes)).toEqual(["negotiate-new-lane"]);
  });

  it("drafts end-state conditions with in and exists, as init --sop does", async () => {
    const domain = await loadDomain(path.resolve("examples/freight"));
    const { client } = fakeClient([withInAndExists]);
    const res = await draftTasksFromTranscripts({ domain, claude: { client }, transcripts: [{ file: "call-1.txt", text: "..." }] });
    expect(res.tasks.map((t) => t.id)).toEqual(["load-stays-open"]);
    expect(res.tasks[0]!.expect.state[0]!.where).toEqual({ load_id: "L-1001", status: { $in: ["available", "pending"] }, booked_by: { $exists: false } });
  });

  it("keeps the chats drafted around a failed call, and names the one that failed (#402)", async () => {
    const domain = await loadDomain(path.resolve("examples/freight"));
    const second = { ...JSON.parse(JSON.stringify(good).replaceAll("L-2001", "L-2002")), id: "negotiate-second-lane", new_persona: null, persona_id: "easygoing" };
    const outputs = [good, second];
    let calls = 0;
    const client = {
      beta: {
        messages: {
          parse: async () => {
            if (++calls === 2) throw new Error("503 Bedrock is unable to process your request.");
            return { stop_reason: "end_turn", parsed_output: outputs.shift(), content: [] };
          },
        },
      },
    } as unknown as Anthropic;
    const res = await draftTasksFromTranscripts({
      domain,
      claude: { client },
      transcripts: ["call-1.txt", "call-2.txt", "call-3.txt"].map((file) => ({ file, text: "..." })),
    });
    expect(calls).toBe(3);
    expect(res.tasks.map((t) => t.id)).toEqual(["negotiate-new-lane", "negotiate-second-lane"]);
    expect(res.rows.loads!.map((r) => r.load_id)).toEqual(["L-2001", "L-2002"]);
    expect(res.failed).toEqual([{ file: "call-2.txt", error: "503 Bedrock is unable to process your request." }]);
  });
});

describe("values a draft copied from its chat", () => {
  it("gives an email that ends a sentence one note, without the period", () => {
    const raw = "Customer: you can reach me at tvale42@mail.example.\nAgent: Thanks.";
    const places = [
      { where: "the caller's script", text: "Write to tvale42@mail.example." },
      { where: "the caller's instructions", text: "Your email is tvale42@mail.example and you want a refund." },
    ];
    const notes = copiedValueNotes(raw, "chat-9.txt", places, "");
    expect(notes.filter((n) => n.includes("@"))).toEqual([
      `copied from chat-9.txt: replace "tvale42@mail.example" with a fictional value (in the caller's script, the caller's instructions)`,
    ]);
  });

  // A fictional chat: the scrub removes the email and phone before sending, and keeps the username.
  const chat = [
    "Agent: Thanks for calling Blue Mesa dispatch.",
    "Customer (Priya Halvorsen): Hi, my name is Priya Halvorsen, my portal username is phalvorsen88.",
    "Customer: Reach me at phalvorsen88@mailbox.example or 415-555-0142. I'm after L-2001.",
  ].join("\n");
  // The model kept the name, the username and the phone, and made an email up from the username.
  const copying = {
    ...good,
    instructions: "You are Priya Halvorsen (username phalvorsen88, phalvorsen88@mail.example, phone 415-555-0142) at Blue Mesa Trucking, MC 100101. You want L-2001. Ask for $2,600; accept $2,250 or more.",
  };

  it("notes each copied value on its task, once, with where it is, and counts them", async () => {
    const domain = await loadDomain(path.resolve("examples/freight"));
    const { client, requests } = fakeClient([copying]);
    const res = await draftTasksFromTranscripts({ domain, claude: { client }, transcripts: [{ file: "chat-7.txt", text: chat }] });
    // The scrub still ran before sending.
    expect(requests[0]!.messages[0]!.content).not.toContain("415-555-0142");
    const where = "(in the caller's instructions)";
    expect(res.notes["negotiate-new-lane"]).toEqual([
      `copied from chat-7.txt: replace "phalvorsen88@mail.example" with a fictional value ${where}`,
      `copied from chat-7.txt: replace "phalvorsen88" with a fictional value ${where}`,
      `copied from chat-7.txt: replace "415-555-0142" with a fictional value ${where}`,
      `copied from chat-7.txt: replace "Priya Halvorsen" with a fictional value ${where}`,
    ]);
    expect(res.copied).toBe(4);
    expect(res.warnings).toContain("chat-7.txt: negotiate-new-lane: 4 value(s) copied from the chat: see its TODO(review) notes");
  });

  it("leaves a draft alone that kept only the call's IDs, and values the domain already has", async () => {
    const domain = await loadDomain(path.resolve("examples/freight"));
    const { client } = fakeClient([good]);
    // L-2001 and MC 100101 are what the task is about; Blue Mesa Trucking is a seeded carrier.
    const res = await draftTasksFromTranscripts({ domain, claude: { client }, transcripts: [{ file: "chat-7.txt", text: `${chat}\nCustomer: This is Blue Mesa Trucking, MC 100101.` }] });
    expect(res.copied).toBe(0);
    expect(res.notes["negotiate-new-lane"]).toBeUndefined();
  });

  it("finds a surname alone, a phone written another way, and a name in a new persona", async () => {
    const domain = await loadDomain(path.resolve("examples/freight"));
    const elsewhere = {
      ...good,
      instructions: "You are Ms. Halvorsen at Blue Mesa Trucking, MC 100101. Call back on (415) 555 0142. You want L-2001. Ask for $2,600; accept $2,250 or more.",
      new_persona: { id: "veteran-dispatcher", description: "Priya Halvorsen, a long-time dispatcher who counters every offer once." },
    };
    const { client } = fakeClient([elsewhere]);
    const res = await draftTasksFromTranscripts({ domain, claude: { client }, transcripts: [{ file: "chat-7.txt", text: chat }] });
    expect(res.notes["negotiate-new-lane"]).toEqual([
      'copied from chat-7.txt: replace "(415) 555 0142" with a fictional value (in the caller\'s instructions)',
      'copied from chat-7.txt: replace "Halvorsen" with a fictional value (in the caller\'s instructions)',
      'copied from chat-7.txt: replace "Priya Halvorsen" with a fictional value (in persona veteran-dispatcher)',
    ]);
  });

  it("finds two-letter handles, an email's local part alone, names a customer message gives, and street addresses", async () => {
    const domain = await loadDomain(path.resolve("examples/freight"));
    const raw = [
      "Agent: Who am I speaking with?",
      "Customer: Marisol Okafor",
      "Agent: And your portal login?",
      "User: Brennan Iyer, and my username is bi447102.",
      "Caller: It's Tavi Lindqvist calling back. Email kito.reyes@mail.example works.",
      "Customer: Ship it to 4417 Larkspur Dr please.",
    ].join("\n");
    const draft = {
      ...good,
      instructions: "You are Marisol Okafor, also known as Brennan Iyer (login bi447102, kito.reyes), with Tavi Lindqvist at Blue Mesa Trucking, MC 100101. You want L-2001. Ask for $2,600; accept $2,250 or more.",
      new_rows: [...good.new_rows, { table: "carriers", fields: [{ name: "mc_number", value: "199901" }, { name: "address", value: "4417 Larkspur Drive" }] }],
    };
    const { client } = fakeClient([draft]);
    const res = await draftTasksFromTranscripts({ domain, claude: { client }, transcripts: [{ file: "chat-9.txt", text: raw }] });
    const values = (res.notes["negotiate-new-lane"] ?? []).map((n) => /replace "([^"]+)"/.exec(n)![1]);
    expect(values.sort()).toEqual(["4417 Larkspur Drive", "Brennan Iyer", "Marisol Okafor", "Tavi Lindqvist", "bi447102", "kito.reyes"].sort());
    expect(res.notes["negotiate-new-lane"]).toContain('copied from chat-9.txt: replace "4417 Larkspur Drive" with a fictional value (in a new carriers row)');
  });

  it("doesn't take a speaker's role, a greeting or a polite reply for a name", async () => {
    const domain = await loadDomain(path.resolve("examples/freight"));
    const raw = "Customer: Thanks Again.\nCustomer: Hello there\nAgent: Order Status, please.\nCustomer: Yes Please.";
    const { client } = fakeClient([{ ...good, instructions: `${good.instructions} Thanks Again. Order Status. Yes Please.` }]);
    const res = await draftTasksFromTranscripts({ domain, claude: { client }, transcripts: [{ file: "chat-10.txt", text: raw }] });
    expect(res.copied).toBe(0);
  });

  it("doesn't take a speaker's role or a greeting for a name", async () => {
    const domain = await loadDomain(path.resolve("examples/freight"));
    const roles = "Customer Service: Hello Team, this is Support Desk.\nSupport Agent: Hi.";
    const { client } = fakeClient([{ ...good, instructions: `${good.instructions} Customer Service and Support Agent were on the call.` }]);
    const res = await draftTasksFromTranscripts({ domain, claude: { client }, transcripts: [{ file: "chat-8.txt", text: roles }] });
    expect(res.copied).toBe(0);
  });
});
