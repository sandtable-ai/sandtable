import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type Anthropic from "@anthropic-ai/sdk";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { appendToDomainList } from "../src/init/merge.ts";
import { draftFromOpenApi } from "../src/init/openapi.ts";
import { DOMAIN_FILE, POLICY_PLACEHOLDER, renderDraft, TASKS_PLACEHOLDER, writeDraft } from "../src/init/render.ts";
import { draftInvariantsFromSop, knownFields, softRuleComments, whereOf } from "../src/init/sop.ts";
import { checkCall } from "../src/grade/invariants.ts";
import { World } from "../src/world/store.ts";
import { loadDomain, pendingReview } from "../src/spec/load.ts";

const SOP = await readFile("examples/freight/policy.md", "utf8");

async function draftedDomainDir() {
  const spec = YAML.parse(await readFile("examples/freight/source/openapi.yaml", "utf8")) as Record<string, unknown>;
  const draft = draftFromOpenApi(spec);
  const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-sop-"));
  await writeDraft(dir, { [DOMAIN_FILE]: renderDraft(draft, "openapi.yaml"), "policy.md": POLICY_PLACEHOLDER, "tasks.yaml": TASKS_PLACEHOLDER });
  const fields = Object.fromEntries(Object.entries(draft.tables).map(([n, t]) => [n, t.fields]));
  return { dir, fields };
}

const none = { first_tool: null, same_args: [], table: null, key_arg: null, conditions: [], arg: null, bound: null, bound_value: null, bound_ref: null, left: null, right: null, protected_field: null, unless_tool: null, unless_arg: null };
const proposals = [
  { ...none, rule_id: "r1", id: "verify-before-book", description: "Vet before booking", quote: "look it up with `verify_carrier` before you discuss booking", kind: "before", tool: "create_booking", first_tool: "get_carrier", same_args: ["mc_number"] },
  { ...none, rule_id: "r2", id: "eligible-carrier", description: "Only eligible carriers", quote: "Do **not** book a carrier if any of these is true", kind: "require", tool: "create_booking", table: "carriers", key_arg: "mc_number", conditions: [{ field: "insurance_status", op: "eq", value: "valid" }, { field: "safety_rating", op: "ne", value: "unsatisfactory" }] },
  { ...none, rule_id: "r3", id: "rate-ceiling", description: "Never above max", quote: "Never book above `max_rate`.", kind: "limit", tool: "create_booking", arg: "rate", bound: "lte", bound_ref: { table: "loads", key_arg: "load_id", field: "max_rate" } },
  { ...none, rule_id: "r4", id: "equipment-match", description: "Equipment must match", quote: "The carrier's equipment must match the load's equipment", kind: "match", tool: "create_booking", left: { table: "carriers", key_arg: "mc_number", field: "equipment" }, right: { table: "loads", key_arg: "load_id", field: "equipment" } },
  { ...none, rule_id: "r5", id: "never-disclose-ceiling", description: "Never reveal max rate", quote: "Never tell the caller the `max_rate`", kind: "never_disclose", tool: "create_booking", protected_field: { table: "loads", field: "max_rate" }, unless_tool: "create_booking", unless_arg: "rate" },
  { ...none, rule_id: "r6", id: "made-up-quote", description: "x", quote: "Always offer a free coffee", kind: "never", tool: "create_booking", conditions: [{ field: "rate", op: "lt", value: 0 }] },
  { ...none, rule_id: "r7", id: "bad-field", description: "x", quote: "x", kind: "require", tool: "create_booking", table: "carriers", key_arg: "mc_number", conditions: [{ field: "credit_score", op: "gte", value: 700 }] },
  { ...none, rule_id: "r8", id: "bad-arg", description: "x", quote: "x", kind: "before", tool: "create_booking", first_tool: "get_carrier", same_args: ["carrier"] },
  { ...none, rule_id: "r9", id: "incomplete", description: "x", quote: "x", kind: "limit", tool: "create_booking" },
];

function fakeClient(parsed: unknown) {
  const requests: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        parse: async (req: Record<string, unknown>) => {
          requests.push(req);
          return { stop_reason: "end_turn", parsed_output: parsed, content: [] };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, requests };
}

describe("init from an SOP", () => {
  it("keeps grounded, valid proposals and explains every drop", async () => {
    const { dir, fields } = await draftedDomainDir();
    const domain = await loadDomain(dir);
    const rules = proposals.map((p) => ({ id: p.rule_id, rule: p.description, quote: p.quote }));
    const { client, requests } = fakeClient({ rules, invariants: proposals, soft_rules: [{ rule_id: "r5", reasons: ["agent_says"], detail: "" }] });

    const res = await draftInvariantsFromSop({ domain, sop: SOP, sopFile: "policy.md", fields: knownFields(domain, fields), claude: { client } });

    expect(res.invariants.map((i) => i.id)).toEqual(["verify-before-book", "eligible-carrier", "rate-ceiling", "equipment-match", "never-disclose-ceiling", "made-up-quote"]);
    expect(res.invariants[4]).toMatchObject({ never_disclose: { table: "loads", field: "max_rate", unless: { tool: "create_booking", arg: "rate" } } });
    expect(res.invariants.every((i) => i.review === "pending" && i.source?.file === "policy.md")).toBe(true);
    expect(res.invariants[1]).toMatchObject({ require: { where: { insurance_status: "valid", safety_rating: { $ne: "unsatisfactory" } } } });
    const w = res.warnings.join("\n");
    expect(w).toMatch(/made-up-quote: quote not found verbatim/);
    expect(w).toMatch(/dropped bad-field: unknown field\(s\) carriers.credit_score/);
    expect(w).toMatch(/dropped bad-arg: .*no param "carrier"/);
    expect(w).toMatch(/dropped incomplete: limit needs arg and bound/);
    // r5 is checked by an invariant and listed as a soft rule (in part); r7-r9 lost their only invariant.
    expect(res.softRules.map((r) => [r.rule, r.reason])).toEqual([
      ["Never reveal max rate", "about what the agent says"],
      ["x", "its drafted invariant was dropped (bad-field: unknown field(s) carriers.credit_score)"],
      ["x", expect.stringMatching(/^its drafted invariant was dropped \(bad-arg: .*no param "carrier"/)],
      ["x", "its drafted invariant was dropped (incomplete: limit needs arg and bound)"],
    ]);

    const req = requests[0] as { system: string; output_config: { effort: string; format: unknown }; messages: Array<{ content: string }> };
    expect(req.system).toMatch(/list every rule the SOP states/);
    expect(req.system).toMatch(/Every rule in `rules` must end up in invariants, in soft_rules, or in both/);
    expect(req.output_config.effort).toBe("high");
    expect(req.output_config.format).toBeDefined();
    expect(req.messages[0]!.content).toContain("create_booking(load_id: string, mc_number: string, rate: number)");
    expect(req.messages[0]!.content).toContain("carriers (key mc_number): mc_number, name, authority_status");
  });

  it("lists every rule no invariant checks as a soft rule, with the reasons, and warns about rules the draft left out", async () => {
    const { dir, fields } = await draftedDomainDir();
    const domain = await loadDomain(dir);
    const sop = [
      "Look the carrier up before you book.",
      "Carriers with a signed fast-pay agreement get paid in 2 days; others within 30 days of delivery, or sooner with a factoring letter.",
      "Start every call by asking for the MC number or the company name.",
      "Thank the caller before you hang up.",
    ].join("\n");
    const rules = [
      { id: "r1", rule: "Look the carrier up before booking", quote: "Look the carrier up before you book." },
      { id: "r2", rule: "Payment terms depend on the agreement and the delivery date", quote: "Carriers with a signed fast-pay agreement get paid in 2 days; others within 30 days of delivery, or sooner with a factoring letter." },
      { id: "r3", rule: "Ask for the MC number or the company name first", quote: "Start every call by asking for the MC number or the company name." },
      { id: "r4", rule: "Thank the caller before hanging up", quote: "Thank the caller before you hang up." },
    ];
    const { client } = fakeClient({
      rules,
      invariants: [{ ...proposals[0], rule_id: "r1", quote: rules[0]!.quote }],
      soft_rules: [
        { rule_id: "r2", reasons: ["needs_date", "fact_not_recorded", "either_or"], detail: "no record holds the agreement or a factoring letter" },
        { rule_id: "r3", reasons: ["any_of_tools", "agent_says"], detail: "" },
        { rule_id: "r9", reasons: ["other"], detail: "made up" },
      ],
    });
    const res = await draftInvariantsFromSop({ domain, sop, sopFile: "sop.md", fields: knownFields(domain, fields), claude: { client } });

    expect(res.invariants.map((i) => i.id)).toEqual(["verify-before-book"]);
    // In SOP order: r2 and r3 as the model classified them, r4 because the model left it out of both lists.
    expect(res.softRules).toEqual([
      { rule: rules[1]!.rule, quote: rules[1]!.quote, reason: "needs today's date; depends on a fact no record holds; needs an either/or condition: no record holds the agreement or a factoring letter" },
      { rule: rules[2]!.rule, quote: rules[2]!.quote, reason: "needs either of several tools first; about what the agent says" },
      { rule: rules[3]!.rule, quote: rules[3]!.quote, reason: "not classified by the draft: check whether it needs an invariant" },
    ]);
    const w = res.warnings.join("\n");
    expect(w).toMatch(/rule r4 \("Thank the caller before hanging up"\) was drafted neither as an invariant nor as a soft rule/);
    expect(w).toMatch(/a soft rule refers to rule r9, which the draft's list of rules doesn't have/);
    expect(softRuleComments(res.softRules)).toContain(' Soft rule, not checked: Thank the caller before hanging up\n   "Thank the caller before you hang up."\n   why: not classified by the draft');
    expect(softRuleComments([])).toBeUndefined();
  });

  it("drafts \"a call like this must include Y\" as never with in and exists: false, and the invariant fires only on the wrong call", async () => {
    const { dir, fields } = await draftedDomainDir();
    const domain = await loadDomain(dir);
    const sop = "When you escalate a payment or a claims question, enter the carrier's MC number.";
    const rules = [{ id: "r1", rule: "A payment or claims escalation includes the MC number", quote: sop }];
    const escalation = {
      ...none,
      rule_id: "r1",
      id: "escalation-needs-mc",
      description: "A payment or claims escalation must include the MC number.",
      quote: sop,
      kind: "never",
      tool: "create_escalation",
      conditions: [
        { field: "reason", op: "in", value: ["payment", "claims"] },
        { field: "mc_number", op: "exists", value: false },
      ],
    };
    const { client, requests } = fakeClient({ rules, invariants: [escalation], soft_rules: [] });
    const res = await draftInvariantsFromSop({ domain, sop, sopFile: "sop.md", fields: knownFields(domain, fields), claude: { client } });

    expect(res.invariants).toHaveLength(1);
    expect(res.invariants[0]).toMatchObject({ never: { tool: "create_escalation", when: { reason: { $in: ["payment", "claims"] }, mc_number: { $exists: false } } } });
    expect(res.softRules).toEqual([]);
    const system = (requests[0] as { system: string }).system;
    expect(system).toMatch(/must include Y/);
    expect(system).toMatch(/in or nin with a list of values/);
    expect(system).toMatch(/A field that may take any of several values is one condition with in, not an either\/or/);

    const checked = { ...domain, invariants: res.invariants };
    const fires = (args: Record<string, unknown>) => checkCall(checked, new World(checked.world), [], { index: 0, name: "create_escalation", args }).length > 0;
    expect(fires({ reason: "payment" })).toBe(true);
    expect(fires({ reason: "claims", mc_number: "100101" })).toBe(false);
    expect(fires({ reason: "detention" })).toBe(false);
  });

  it("turns drafted conditions into a where clause, or says why it can't", () => {
    expect(whereOf([{ field: "status", op: "in", value: "open" }])).toEqual({ status: { $in: ["open"] } });
    expect(whereOf([{ field: "status", op: "nin", value: ["closed", "void"] }])).toEqual({ status: { $nin: ["closed", "void"] } });
    expect(whereOf([{ field: "rate", op: "gte", value: 10 }, { field: "rate", op: "lte", value: 100 }])).toEqual({ rate: { $gte: 10, $lte: 100 } });
    expect(whereOf([{ field: "status", op: "eq", value: "open" }, { field: "status", op: "ne", value: "void" }])).toEqual({ status: { $eq: "open", $ne: "void" } });
    expect(whereOf([{ field: "status", op: "eq", value: ["open"] }])).toBe("status: eq takes one value, not a list");
    expect(whereOf([{ field: "note", op: "exists", value: "no" }])).toBe('note: exists takes true or false, not "no"');
    expect(whereOf([{ field: "rate", op: "lte", value: 10 }, { field: "rate", op: "lte", value: 20 }])).toBe("rate: two lte conditions");
  });

  it("drops a drafted condition it can't turn into a where clause, with the reason", async () => {
    const { dir, fields } = await draftedDomainDir();
    const domain = await loadDomain(dir);
    const sop = "Escalate only with a reason.";
    const rules = [{ id: "r1", rule: "Escalations have a reason", quote: sop }];
    const bad = { ...none, rule_id: "r1", id: "bad-exists", description: "x", quote: sop, kind: "never", tool: "create_escalation", conditions: [{ field: "reason", op: "exists", value: "no" }] };
    const { client } = fakeClient({ rules, invariants: [bad], soft_rules: [] });
    const res = await draftInvariantsFromSop({ domain, sop, sopFile: "sop.md", fields: knownFields(domain, fields), claude: { client } });
    expect(res.invariants).toEqual([]);
    expect(res.warnings.join("\n")).toMatch(/dropped bad-exists: reason: exists takes true or false, not "no"/);
    expect(res.softRules[0]).toMatchObject({ reason: 'its drafted invariant was dropped (bad-exists: reason: exists takes true or false, not "no")' });
  });

  it("appends drafted invariants to the domain, keeping comments, as pending review", async () => {
    const { dir, fields } = await draftedDomainDir();
    const domain = await loadDomain(dir);
    const rules = [
      { id: "r1", rule: "Vet before booking", quote: "look it up with `verify_carrier` before you discuss booking" },
      { id: "r2", rule: "Only eligible carriers", quote: "Do **not** book a carrier if any of these is true" },
      { id: "r3", rule: "Read the load back before booking", quote: "Read back the lane, date and rate\n  before you book." },
    ];
    const { client } = fakeClient({ rules, invariants: proposals.slice(0, 2), soft_rules: [{ rule_id: "r3", reasons: ["agent_says"], detail: "" }] });
    const res = await draftInvariantsFromSop({ domain, sop: SOP, sopFile: "policy.md", fields: knownFields(domain, fields), claude: { client } });

    await appendToDomainList(dir, "invariants", res.invariants, softRuleComments(res.softRules));
    const text = await readFile(path.join(dir, DOMAIN_FILE), "utf8");
    expect(text).toContain("# TODO(review): The API can answer 409");
    expect(text).toContain(['  # Soft rule, not checked: Read the load back before booking', '  #   "Read back the lane, date and rate before you book."', "  #   why: about what the agent says"].join("\n"));
    expect(text).toMatch(/before: \{ first: get_carrier, then: create_booking, same: \[ mc_number \] \}/);

    const reloaded = await loadDomain(dir);
    expect(reloaded.invariants.map((i) => i.id)).toEqual(["verify-before-book", "eligible-carrier"]);
    expect(pendingReview(reloaded).filter((p) => p.kind === "invariant")).toHaveLength(2);
  });
});

// What 0.1.0-alpha.1 wrote to policy.md. A draft made by that release still holds it until someone edits it.
const ALPHA_1_POLICY_PLACEHOLDER = `# Policy

TODO: paste the customer's operating procedure (SOP) here, or draft from one with \`sandtable init --sop <file>\`.
The reference agent uses this text as its system prompt.
`;

describe.skipIf(!process.features.typescript)("init --sop on an existing draft", () => {
  it.each([
    ["this release", POLICY_PLACEHOLDER],
    ["0.1.0-alpha.1", ALPHA_1_POLICY_PLACEHOLDER],
  ])("replaces the placeholder policy.md that %s wrote with the SOP", async (_, placeholder) => {
    const { dir } = await draftedDomainDir();
    await writeFile(path.join(dir, "policy.md"), placeholder);
    const sop = path.join(dir, "sop.md");
    await writeFile(sop, SOP);
    // No credentials anywhere, so the invariant-drafting call fails before anything is sent.
    // init replaces the placeholder policy.md before it drafts.
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|AWS_|SANDTABLE_)/.test(k))),
      HOME: dir,
      XDG_CONFIG_HOME: dir,
    };
    const init = promisify(execFile)(process.execPath, [path.resolve("src/cli.ts"), "init", "--sop", sop, "-o", dir, "--provider", "anthropic"], { env });
    await expect(init).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(await readFile(path.join(dir, "policy.md"), "utf8")).toBe(SOP);
  });
});
