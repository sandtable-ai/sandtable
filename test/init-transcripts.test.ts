import { cp, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { freightScriptedAgent } from "../src/demo/freight-agents.ts";
import { appendRows, appendToDomainList } from "../src/init/merge.ts";
import { draftTasksFromTranscripts, scrubPii } from "../src/init/transcripts.ts";
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

function fakeClient(outputs: unknown[]) {
  const requests: Array<{ messages: Array<{ content: string }> }> = [];
  const client = {
    beta: {
      messages: {
        parse: async (req: { messages: Array<{ content: string }> }) => {
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
    expect(res.tasks[0]!.expect.state[0]!.where).toEqual({ load_id: "L-2001", mc_number: "100101", rate: { $lte: 2400 } });
    expect(res.personas.map((p) => p.id)).toEqual(["veteran-dispatcher"]);
    expect(res.rows.loads).toHaveLength(1);
    expect(res.warnings).toEqual([
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
});
