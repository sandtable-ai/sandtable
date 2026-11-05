import { cp, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { freightScriptedAgent } from "../src/demo/freight-agents.ts";
import { addClock, appendRows, appendToDomainList } from "../src/init/merge.ts";
import { lintDomain } from "../src/grade/lint.ts";
import { copiedValueNotes } from "../src/init/copied.ts";
import { callDateIn, parseCallDate, relativeToCall } from "../src/init/relative-dates.ts";
import { draftTasksFromTranscripts, onlyThisTranscript, reusedRowConflicts, scrubPii } from "../src/init/transcripts.ts";
import { runSuite } from "../src/run/suite.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import { dateOf, expressionFor, resolveDates } from "../src/spec/clock.ts";
import { DOMAIN_FILE, loadDomain, pendingReview, validateDomain } from "../src/spec/load.ts";
import { TaskSpec, type Domain } from "../src/spec/schema.ts";

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

/** The note on a drafted task that holds a date, such as good's pickup date, from a chat that states no call date (#466). */
const NO_CALL_DATE = "this chat states no call date, so its dates are literal and may be past when the suite runs: pass --call-date, or make them relative ($today+2d) by hand";

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
    // No conflict: only the note on good's literal pickup date.
    expect(res.notes).toEqual({ "negotiate-new-lane": [NO_CALL_DATE] });
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
    expect(res.notes["negotiate-new-lane"]).toEqual([NO_CALL_DATE]);
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
    expect(res.notes).toEqual({ "negotiate-new-lane": [NO_CALL_DATE] });
  });

  it("keeps a value that matches no allowed value, or several, for review", async () => {
    const domain = await loadDomain(path.resolve("examples/freight"));
    const { client } = fakeClient([noSuchValue]);
    const res = await draftTasksFromTranscripts({ domain, claude: { client }, transcripts: [{ file: "call-1.txt", text: "..." }] });
    expect(res.tasks[0]!.reference![1]!.args).toEqual({ origin: "Dallas", equipment: "Box Truck" });
    expect(res.warnings).toEqual([expect.stringMatching(/^call-1\.txt: negotiate-new-lane: reference\[1\] search_loads: invalid arguments: argument "equipment" must be one of dry_van, reefer, flatbed$/)]);
    expect(res.notes["negotiate-new-lane"]).toEqual([NO_CALL_DATE, expect.stringMatching(/^lint: reference\[1\] search_loads: invalid arguments: .*\. Fix the expectation, the seed rows or the reference\.$/)]);

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

  /** Draft call-1 to call-3, with the second call (or the one at `failAt`) throwing `error`. */
  async function draftWithFailure(error: Error, failAt = 2) {
    const domain = await loadDomain(path.resolve("examples/freight"));
    const second = { ...JSON.parse(JSON.stringify(good).replaceAll("L-2001", "L-2002")), id: "negotiate-second-lane", new_persona: null, persona_id: "easygoing" };
    const outputs = [good, second];
    let calls = 0;
    const client = {
      beta: {
        messages: {
          parse: async () => {
            if (++calls === failAt) throw error;
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
    return { res, calls };
  }

  it("keeps the chats drafted around a call that failed for that chat alone, and names it (#402)", async () => {
    const { res, calls } = await draftWithFailure(Object.assign(new Error("503 Bedrock is unable to process your request."), { status: 503 }));
    expect(calls).toBe(3);
    expect(res.tasks.map((t) => t.id)).toEqual(["negotiate-new-lane", "negotiate-second-lane"]);
    expect(res.rows.loads!.map((r) => r.load_id)).toEqual(["L-2001", "L-2002"]);
    expect(res.failed).toEqual([{ file: "call-2.txt", error: "503 Bedrock is unable to process your request." }]);
    expect(res.notSent).toEqual([]);
  });

  it("stops at an error every later call would hit too, keeping what was drafted and listing the chats not sent", async () => {
    // A denied model, after the first chat drafted.
    const denied = await draftWithFailure(Object.assign(new Error("403 You don't have access to the model with the specified model ID."), { status: 403 }));
    expect(denied.calls).toBe(2);
    expect(denied.res.tasks.map((t) => t.id)).toEqual(["negotiate-new-lane"]);
    expect(denied.res.failed).toEqual([{ file: "call-2.txt", error: "403 You don't have access to the model with the specified model ID." }]);
    expect(denied.res.notSent).toEqual(["call-3.txt"]);
    // Missing credentials have no HTTP status: nothing more is sent after the first chat.
    const noCredentials = await draftWithFailure(new Error("no AWS credentials for profile no-such-profile"), 1);
    expect(noCredentials.calls).toBe(1);
    expect(noCredentials.res.tasks).toEqual([]);
    expect(noCredentials.res.failed).toEqual([{ file: "call-1.txt", error: "no AWS credentials for profile no-such-profile" }]);
    expect(noCredentials.res.notSent).toEqual(["call-2.txt", "call-3.txt"]);
  });

  it("goes on only after an error that can concern one chat alone", () => {
    const status = (s: number) => Object.assign(new Error(`${s}`), { status: s });
    for (const s of [400, 413, 429, 500, 503, 529]) expect(onlyThisTranscript(status(s))).toBe(true);
    for (const s of [401, 403, 404]) expect(onlyThisTranscript(status(s))).toBe(false);
    expect(onlyThisTranscript(new Error("Connection error."))).toBe(false);
    expect(onlyThisTranscript("not an error")).toBe(false);
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
      NO_CALL_DATE,
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
    // Nothing copied: only the note on good's literal pickup date.
    expect(res.notes["negotiate-new-lane"]).toEqual([NO_CALL_DATE]);
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
      NO_CALL_DATE,
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
    const values = (res.notes["negotiate-new-lane"] ?? []).filter((n) => n.startsWith("copied from")).map((n) => /replace "([^"]+)"/.exec(n)![1]);
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

describe("dates relative to the call (#466)", () => {
  /** A booking two days after the call: a pickup date, a time to be there, and when the load was posted, in values and in text. */
  const dated = {
    ...withReference,
    id: "book-pickup-two-days-out",
    new_persona: null,
    persona_id: "easygoing",
    instructions: "You are Dana at Blue Mesa Trucking, MC 100101. You want L-2001, which picks up 2026-03-16; be at the dock by 2026-03-16T08:05. Ask for $2,600; accept $2,250 or more.",
    script: ["Hi, MC 100101. Is L-2001 still picking up 2026-03-16?", "I need $2,600.", "How about $2,300?", "Deal, book it.", "Thanks."],
    new_rows: [
      {
        table: "loads",
        fields: [...good.new_rows[0]!.fields.map((f) => (f.name === "pickup_date" ? { ...f, value: "2026-03-16" } : f)), { name: "posted_at", value: "2026-03-14T08:35" }],
      },
    ],
    expect_state: [
      { table: "loads", conditions: [{ field: "load_id", op: "eq", value: "L-2001" }, { field: "pickup_date", op: "gte", value: "2026-03-15" }], count: 1 },
      ...good.expect_state,
    ],
  };
  const STAMPED = "Call started 2026-03-14 10:05:41\nREP: Thanks for calling.\nCALLER: Is the load still on for Monday?";
  const UNSTAMPED = "REP: Thanks for calling.\nCALLER: Is the load still on for Monday?";
  /** A load that picks up before today can't be booked: the rule that makes a literal date go stale. */
  const NOT_PAST = { table: "loads", key: "$load_id", where: { pickup_date: { $gte: "$today" } }, error: "Load ${load_id} picked up before ${today}" };
  /** The freight example on a clock of now, with no tasks, whose book_load refuses a load that picked up already. */
  async function clockedFreight(): Promise<Domain> {
    const d = await loadDomain(path.resolve("examples/freight"));
    return { ...d, clock: "now", tasks: [], tools: d.tools.map((t) => (t.name === "book_load" ? { ...t, checks: [...t.checks, NOT_PAST] } : t)) };
  }
  /** The domain with a draft's rows, personas and tasks added, as init writes them. */
  const merged = (domain: Domain, res: Awaited<ReturnType<typeof draftTasksFromTranscripts>>): Domain => ({
    ...domain,
    ...(res.clockNow ? { clock: "now" } : {}),
    world: { tables: Object.fromEntries(Object.entries(domain.world.tables).map(([name, t]) => [name, { ...t, rows: [...t.rows, ...(res.rows[name] ?? [])] }])) },
    personas: [...domain.personas, ...res.personas],
    tasks: [...domain.tasks, ...res.tasks],
  });
  const draft = async (domain: Domain, text: string, extra: { callDate?: string; proposal?: object } = {}) => {
    const { client, requests } = fakeClient([extra.proposal ?? dated]);
    const res = await draftTasksFromTranscripts({ domain, claude: { client }, transcripts: [{ file: "call-1.txt", text }], ...(extra.callDate ? { callDate: extra.callDate } : {}) });
    return { res, requests };
  };
  // Far apart: the day of the call, and years later.
  const DAYS = [new Date(2026, 2, 14, 10, 5), new Date(2031, 6, 1, 9, 0)];

  it("reads the call's date and time from the first five non-empty lines of the file, locally", () => {
    expect(callDateIn("Call started 2026-03-14 10:05:41\nREP: Hi.")).toBe("2026-03-14T10:05");
    expect(callDateIn("\n\n  \nRecorded: 2026-03-14T10:05:41.250Z\n")).toBe("2026-03-14T10:05");
    expect(callDateIn("Date: 2026-03-14\nTime: 10:05")).toBe("2026-03-14");
    expect(callDateIn("Ref 2026-02-30, call on 2026-03-01T16:20+01:00")).toBe("2026-03-01T16:20");
    expect(callDateIn("a\nb\nc\nd\ne\nCall started 2026-03-14")).toBeUndefined();
    expect(callDateIn("Booking BK-2026-03-14 confirmed.")).toBeUndefined();
    expect(callDateIn(UNSTAMPED)).toBeUndefined();
  });

  it("takes a --call-date of a date, or a date and a time to the minute, and nothing else", () => {
    expect(["2026-03-14", "2026-03-14T10:05"].map(parseCallDate)).toEqual(["2026-03-14", "2026-03-14T10:05"]);
    for (const bad of ["2026-02-30", "2026-03-14T24:00", "2026-03-14 10:05", "2026-03-14T10:05:00", "14/03/2026", "March 14", ""]) expect(parseCallDate(bad), bad).toBeUndefined();
  });

  it("writes each date as the expression that resolves to it, in the largest exact unit", () => {
    const CALL = "2026-03-14T10:05";
    const cases: [string, string][] = [
      ["2026-03-14", "today"],
      ["2026-03-16", "today+2d"],
      ["2026-03-10", "today-4d"],
      ["2027-03-14", "today+365d"],
      ["2026-03-14T10:05", "now"],
      ["2026-03-16T10:05", "now+2d"],
      ["2026-03-16T08:05", "now+46h"],
      ["2026-03-14T08:35", "now-90m"],
    ];
    for (const [value, expression] of cases) {
      expect(expressionFor(value, CALL), value).toBe(expression);
      expect(dateOf(`$${expression}`, CALL), expression).toBe(value);
    }
    expect(expressionFor("tomorrow", CALL)).toBeUndefined();
  });

  it("makes each drafted date relative to the call the file states, sets clock: now on a domain with none, and notes what moved", async () => {
    const domain = await loadDomain(path.resolve("examples/freight"));
    const { res } = await draft(domain, STAMPED);
    expect(res.warnings).toEqual([]);
    const task = res.tasks[0]!;
    expect(task.user.instructions).toBe("You are Dana at Blue Mesa Trucking, MC 100101. You want L-2001, which picks up ${today+2d}; be at the dock by ${now+46h}. Ask for $2,600; accept $2,250 or more.");
    expect(task.user.script![0]).toBe("Hi, MC 100101. Is L-2001 still picking up ${today+2d}?");
    expect(task.expect.state[0]!.where).toEqual({ load_id: "L-2001", pickup_date: { $gte: "$today+1d" } });
    expect(res.rows.loads![0]).toMatchObject({ load_id: "L-2001", pickup_date: "$today+2d", posted_at: "$now-90m" });
    expect(res.notes[task.id]).toContain(
      "dates made relative to the call on 2026-03-14T10:05: user.instructions 2026-03-16 → ${today+2d}, user.instructions 2026-03-16T08:05 → ${now+46h}, user.script[0] 2026-03-16 → ${today+2d}, " +
        "expect.state[0].where.pickup_date.$gte 2026-03-15 → $today+1d, new loads row L-2001 pickup_date 2026-03-16 → $today+2d, new loads row L-2001 posted_at 2026-03-14T08:35 → $now-90m",
    );
    expect(res.clockNow).toBe(true);
    expect(res.relative).toEqual([task.id]);
    // What the domain held before this run stays as it was.
    expect(domain.world.tables.loads!.rows[0]!.pickup_date).toBe("2026-11-04");
    expect(validateDomain(merged(domain, res))).toEqual([]);
    // Other text keeps its dates: the source quote and description are no place a date resolves.
    const { res: quoted } = await draft(domain, STAMPED, { proposal: { ...dated, description: "A booking for 2026-03-16.", quote: "On 2026-03-16?" } });
    expect([quoted.tasks[0]!.description, quoted.tasks[0]!.source?.quote]).toEqual(["A booking for 2026-03-16.", "On 2026-03-16?"]);
  });

  it("lints clean on any day with clock: now, where the same chat's literal dates go stale", async () => {
    const domain = await clockedFreight();
    const { res } = await draft(domain, STAMPED);
    // A domain that sets a clock keeps it.
    expect(res.clockNow).toBe(false);
    for (const now of DAYS) expect(lintDomain(merged(domain, res), { now }).tasks[0], String(now)).toMatchObject({ solvable: true, errors: [] });
    // With no call date, the dates stay literal, with a note, and the booking fails once its pickup has passed.
    const { res: literal } = await draft(domain, UNSTAMPED);
    expect(literal.relative).toEqual([]);
    expect(literal.rows.loads![0]!.pickup_date).toBe("2026-03-16");
    expect(literal.notes[literal.tasks[0]!.id]).toContain(NO_CALL_DATE);
    expect(literal.literal).toEqual(["book-pickup-two-days-out"]);
    expect(lintDomain(merged(domain, literal), { now: DAYS[0] }).tasks[0]!.errors).toEqual([]);
    expect(lintDomain(merged(domain, literal), { now: DAYS[1] }).tasks[0]!.errors).not.toEqual([]);
  });

  it("dates a chat that states none by --call-date, and a date the file states wins", async () => {
    const domain = await clockedFreight();
    const { res } = await draft(domain, UNSTAMPED, { callDate: "2026-03-10" });
    expect(res.rows.loads![0]!.pickup_date).toBe("$today+6d");
    expect(res.notes[res.tasks[0]!.id]!.find((n) => n.startsWith("dates made relative"))).toMatch(/^dates made relative to the call on 2026-03-10: /);
    const { res: stated } = await draft(domain, STAMPED, { callDate: "2026-03-10" });
    expect(stated.rows.loads![0]!.pickup_date).toBe("$today+2d");
    await expect(draftTasksFromTranscripts({ domain, claude: { client: fakeClient([]).client }, transcripts: [], callDate: "2026-02-30" })).rejects.toThrow(
      "callDate must be a date, YYYY-MM-DD, or a date and time, YYYY-MM-DDTHH:MM, not 2026-02-30",
    );
  });

  it("leaves a date and time literal when the call's time isn't known, and says so", async () => {
    const domain = await clockedFreight();
    const { res } = await draft(domain, "Call on 2026-03-14\nREP: Thanks for calling.");
    expect(res.tasks[0]!.user.instructions).toContain("which picks up ${today+2d}; be at the dock by 2026-03-16T08:05.");
    expect(res.rows.loads![0]).toMatchObject({ pickup_date: "$today+2d", posted_at: "2026-03-14T08:35" });
    expect(res.notes[res.tasks[0]!.id]).toContain(
      "this chat states its call's date, 2026-03-14, but not its time, so its dates and times stay literal and may be past when the suite runs: user.instructions 2026-03-16T08:05, new loads row L-2001 posted_at 2026-03-14T08:35. Make them relative ($now+2d) by hand",
    );
  });

  it("rewrites every place a trial resolves dates in, and no other", async () => {
    const task = TaskSpec.parse({
      id: "t",
      description: "Rebook from 2026-03-16.",
      user: { instructions: "Pickup 2026-03-16.", opening: "Is 2026-03-16 still on?", script: ["2026-03-16?"] },
      given: { rows: { loads: [{ load_id: "L-1", pickup_date: "2026-03-16", note: "moved from 2026-03-15" }] }, context: { called_at: "2026-03-14T10:05" } },
      events: [{ after: { tool: "get_load" }, update: "loads", key: "L-1", set: { pickup_date: "2026-03-17" } }],
      faults: [{ tool: "get_load", error: "rate_limit", message: "Retry after 2026-03-14T10:10." }],
      reference: [{ tool: "book_load", args: { load_id: "L-1", pickup_date: "2026-03-16" } }],
      expect: {
        state: [{ table: "loads", key: "L-1", fields: { pickup_date: "2026-03-17" } }],
        called: [{ tool: "book_load", args: { pickup_date: "2026-03-16" } }],
        not_called: [{ tool: "book_load", args: { pickup_date: { $lt: "2026-03-14" } } }],
        reply_includes: ["see you on 2026-03-16", "ref BK-2026-03-16"],
      },
    });
    const { task: t, rows } = relativeToCall(task, { loads: [{ load_id: "L-2", pickup_date: "2026-03-18" }] }, "2026-03-14T10:05", { loads: "load_id" });
    expect(t.description).toBe("Rebook from 2026-03-16.");
    expect(t.user).toEqual({ instructions: "Pickup ${today+2d}.", opening: "Is ${today+2d} still on?", script: ["${today+2d}?"] });
    // A seed field is a whole value: a date inside its text stays.
    expect(t.given).toEqual({ rows: { loads: [{ load_id: "L-1", pickup_date: "$today+2d", note: "moved from 2026-03-15" }] }, context: { called_at: "$now" } });
    expect(t.events![0]).toMatchObject({ set: { pickup_date: "$today+3d" } });
    expect(t.faults![0]!.message).toBe("Retry after ${now+5m}.");
    expect(t.reference![0]!.args).toEqual({ load_id: "L-1", pickup_date: "$today+2d" });
    // A date inside an ID stays.
    expect(t.expect).toEqual({
      state: [{ table: "loads", key: "L-1", fields: { pickup_date: "$today+3d" } }],
      called: [{ tool: "book_load", args: { pickup_date: "$today+2d" } }],
      not_called: [{ tool: "book_load", args: { pickup_date: { $lt: "$today" } } }],
      reply_includes: ["see you on ${today+2d}", "ref BK-2026-03-16"],
    });
    expect(rows).toEqual({ loads: [{ load_id: "L-2", pickup_date: "$today+4d" }] });
    // At the call's clock, a trial resolves every expression back to the date it replaced.
    expect(resolveDates(await loadDomain(path.resolve("examples/freight")), t, "2026-03-14T10:05").task).toEqual(task);
  });

  it("tells the model to write dates as YYYY-MM-DD, and times as YYYY-MM-DDTHH:MM", async () => {
    const { requests } = await draft(await clockedFreight(), STAMPED);
    expect(requests[0]!.system).toContain("Write every date you draft as YYYY-MM-DD, and a date with a time as YYYY-MM-DDTHH:MM");
  });

  it("writes clock: now into sandtable.yaml after the policy, so the domain init wrote lints clean on any day", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-tx-"));
    await cp(path.resolve("examples/freight"), dir, { recursive: true });
    const { res } = await draft(await loadDomain(dir), STAMPED);
    await appendRows(dir, res.rows);
    await appendToDomainList(dir, "tasks", res.tasks, undefined, res.notes);
    expect(res.clockNow).toBe(true);
    expect(await addClock(dir, "now")).toBe(true);
    const yaml = await readFile(path.join(dir, DOMAIN_FILE), "utf8");
    expect(yaml).toMatch(/^policy: \.\/policy\.md\nclock: now\n/m);
    expect(await readFile(path.join(dir, "tasks.yaml"), "utf8")).toContain("# TODO(review): dates made relative to the call on 2026-03-14T10:05: ");
    const domain = await loadDomain(dir);
    expect(domain.clock).toBe("now");
    for (const now of DAYS) expect(lintDomain({ ...domain, tasks: domain.tasks.filter((t) => t.id === "book-pickup-two-days-out") }, { now }).tasks[0], String(now)).toMatchObject({ solvable: true, errors: [] });
    // A domain that sets a clock keeps it.
    expect(await addClock(dir, "2026-11-02T09:00")).toBe(false);
    expect((await loadDomain(dir)).clock).toBe("now");
  });
});
