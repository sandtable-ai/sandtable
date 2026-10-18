import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { appendToDomainList } from "../src/init/merge.ts";
import { draftFromOpenApi } from "../src/init/openapi.ts";
import { DOMAIN_FILE, POLICY_PLACEHOLDER, renderDraft, TASKS_PLACEHOLDER, writeDraft } from "../src/init/render.ts";
import { draftInvariantsFromSop, knownFields } from "../src/init/sop.ts";
import { loadDomain, pendingReview } from "../src/spec/load.ts";

const SOP = await readFile("examples/freight/policy.md", "utf8");

async function draftedDomainDir() {
  const spec = YAML.parse(await readFile("examples/freight/source/openapi.yaml", "utf8")) as Record<string, unknown>;
  const draft = draftFromOpenApi(spec);
  const dir = await mkdtemp(path.join(os.tmpdir(), "rehearse-sop-"));
  await writeDraft(dir, { [DOMAIN_FILE]: renderDraft(draft, "openapi.yaml"), "policy.md": POLICY_PLACEHOLDER, "tasks.yaml": TASKS_PLACEHOLDER });
  const fields = Object.fromEntries(Object.entries(draft.tables).map(([n, t]) => [n, t.fields]));
  return { dir, fields };
}

const none = { first_tool: null, same_args: [], table: null, key_arg: null, conditions: [], arg: null, bound: null, bound_value: null, bound_ref: null, left: null, right: null };
const proposals = [
  { ...none, id: "verify-before-book", description: "Vet before booking", quote: "look it up with `verify_carrier` before you discuss booking", kind: "before", tool: "create_booking", first_tool: "get_carrier", same_args: ["mc_number"] },
  { ...none, id: "eligible-carrier", description: "Only eligible carriers", quote: "Do **not** book a carrier if any of these is true", kind: "require", tool: "create_booking", table: "carriers", key_arg: "mc_number", conditions: [{ field: "insurance_status", op: "eq", value: "valid" }, { field: "safety_rating", op: "ne", value: "unsatisfactory" }] },
  { ...none, id: "rate-ceiling", description: "Never above max", quote: "Never book above `max_rate`.", kind: "limit", tool: "create_booking", arg: "rate", bound: "lte", bound_ref: { table: "loads", key_arg: "load_id", field: "max_rate" } },
  { ...none, id: "equipment-match", description: "Equipment must match", quote: "The carrier's equipment must match the load's equipment", kind: "match", tool: "create_booking", left: { table: "carriers", key_arg: "mc_number", field: "equipment" }, right: { table: "loads", key_arg: "load_id", field: "equipment" } },
  { ...none, id: "made-up-quote", description: "x", quote: "Always offer a free coffee", kind: "never", tool: "create_booking", conditions: [{ field: "rate", op: "lt", value: 0 }] },
  { ...none, id: "bad-field", description: "x", quote: "x", kind: "require", tool: "create_booking", table: "carriers", key_arg: "mc_number", conditions: [{ field: "credit_score", op: "gte", value: 700 }] },
  { ...none, id: "bad-arg", description: "x", quote: "x", kind: "before", tool: "create_booking", first_tool: "get_carrier", same_args: ["carrier"] },
  { ...none, id: "incomplete", description: "x", quote: "x", kind: "limit", tool: "create_booking" },
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
    const { client, requests } = fakeClient({ invariants: proposals, soft_rules: [{ rule: "Never disclose max_rate", quote: "Never tell the caller the `max_rate`" }] });

    const res = await draftInvariantsFromSop({ domain, sop: SOP, sopFile: "policy.md", fields: knownFields(domain, fields), claude: { client } });

    expect(res.invariants.map((i) => i.id)).toEqual(["verify-before-book", "eligible-carrier", "rate-ceiling", "equipment-match", "made-up-quote"]);
    expect(res.invariants.every((i) => i.review === "pending" && i.source?.file === "policy.md")).toBe(true);
    expect(res.invariants[1]).toMatchObject({ require: { where: { insurance_status: "valid", safety_rating: { $ne: "unsatisfactory" } } } });
    const w = res.warnings.join("\n");
    expect(w).toMatch(/made-up-quote: quote not found verbatim/);
    expect(w).toMatch(/dropped bad-field: unknown field\(s\) carriers.credit_score/);
    expect(w).toMatch(/dropped bad-arg: .*no param "carrier"/);
    expect(w).toMatch(/dropped incomplete: limit needs arg and bound/);
    expect(res.softRules).toHaveLength(1);

    const req = requests[0] as { system: string; output_config: { effort: string; format: unknown }; messages: Array<{ content: string }> };
    expect(req.output_config.effort).toBe("high");
    expect(req.output_config.format).toBeDefined();
    expect(req.messages[0]!.content).toContain("create_booking(load_id: string, mc_number: string, rate: number)");
    expect(req.messages[0]!.content).toContain("carriers (key mc_number): mc_number, name, authority_status");
  });

  it("appends drafted invariants to the domain, keeping comments, as pending review", async () => {
    const { dir, fields } = await draftedDomainDir();
    const domain = await loadDomain(dir);
    const { client } = fakeClient({ invariants: proposals.slice(0, 2), soft_rules: [] });
    const res = await draftInvariantsFromSop({ domain, sop: SOP, sopFile: "policy.md", fields: knownFields(domain, fields), claude: { client } });

    await appendToDomainList(dir, "invariants", res.invariants, " Soft rule (not checkable from tool calls yet): never disclose max_rate");
    const text = await readFile(path.join(dir, DOMAIN_FILE), "utf8");
    expect(text).toContain("# TODO(review): The API can answer 409");
    expect(text).toContain("# Soft rule (not checkable from tool calls yet)");
    expect(text).toMatch(/before: \{ first: get_carrier, then: create_booking, same: \[ mc_number \] \}/);

    const reloaded = await loadDomain(dir);
    expect(reloaded.invariants.map((i) => i.id)).toEqual(["verify-before-book", "eligible-carrier"]);
    expect(pendingReview(reloaded).filter((p) => p.kind === "invariant")).toHaveLength(2);
  });
});
