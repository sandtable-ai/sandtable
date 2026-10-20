import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { draftInvariantsFromSop, knownFields } from "../src/init/sop.ts";
import { domainWarnings, loadDomain, validateDomain } from "../src/spec/load.ts";
import { DomainSpec, InvariantSpec, ToolSpec, type Domain, type Invariant } from "../src/spec/schema.ts";

// never_disclose looks for numbers and strings of 3 or more characters in what the agent says.
// On a field of booleans or very short values it can never fire, so it must not pass review silently.

// A small fictional carrier desk; the bundled examples change on their own schedule.
const freight = async (): Promise<Domain> =>
  DomainSpec.parse({
    name: "carrier-desk",
    policy: "Book only vetted carriers.",
    world: {
      tables: {
        carriers: {
          key: "mc_number",
          rows: [
            { mc_number: "100101", name: "Blue Mesa Trucking", do_not_use: false },
            { mc_number: "100202", name: "Northline Haulers", do_not_use: true },
          ],
        },
        loads: { key: "load_id", rows: [{ load_id: "L-1001", posted_rate: 2100, max_rate: 2350 }] },
        bookings: { key: "booking_id", rows: [] },
      },
    },
    tools: [
      {
        name: "book_load",
        description: "Book a load for a carrier.",
        params: { load_id: { type: "string" }, mc_number: { type: "string" }, rate: { type: "number" } },
        ops: [{ create: "bookings", values: { load_id: "$load_id", mc_number: "$mc_number", rate: "$rate" } }],
      },
    ],
  });
const protect = (table: string, field: string): Invariant =>
  ({ id: `protect-${field}`, description: `Never reveal ${field}`, never_disclose: { table, field } }) as Invariant;
const withInvariant = (d: Domain, inv: Invariant): Domain => ({ ...d, invariants: [...d.invariants, inv] });

describe("validateDomain on never_disclose fields", () => {
  it("rejects a field that holds booleans", async () => {
    const problems = validateDomain(withInvariant(await freight(), protect("carriers", "do_not_use")));
    expect(problems).toEqual([
      expect.stringMatching(/^invariants\.protect-do_not_use: never_disclose can never fire on carriers\.do_not_use: it holds booleans/),
    ]);
  });

  it("rejects a field whose seeded values are all shorter than 3 characters", async () => {
    const d = await freight();
    const carriers = d.world.tables.carriers!;
    const tiered = { ...d, world: { tables: { ...d.world.tables, carriers: { ...carriers, rows: carriers.rows.map((r) => ({ ...r, tier: "A" })) } } } };
    expect(validateDomain(withInvariant(tiered, protect("carriers", "tier")))).toEqual([expect.stringMatching(/shorter than 3 characters/)]);
  });

  it("accepts numbers, longer text, and fields the seed rows don't have", async () => {
    const d = await freight();
    expect(validateDomain(d)).toEqual([]);
    expect(validateDomain(withInvariant(d, protect("loads", "max_rate")))).toEqual([]);
    expect(validateDomain(withInvariant(d, protect("carriers", "name")))).toEqual([]);
    expect(validateDomain(withInvariant(d, protect("bookings", "confirmation_code")))).toEqual([]);
  });
});

describe("init from an SOP", () => {
  it("drops a drafted never_disclose on a boolean field, with the reason", async () => {
    const domain = await freight();
    const sop = "Never tell the caller that a carrier is flagged do-not-use.";
    const proposal = {
      id: "never-disclose-dnu", description: "Never reveal the do-not-use flag", quote: sop, kind: "never_disclose", tool: "book_load",
      first_tool: null, same_args: [], table: null, key_arg: null, conditions: [], arg: null, bound: null, bound_value: null, bound_ref: null,
      left: null, right: null, protected_field: { table: "carriers", field: "do_not_use" }, unless_tool: null, unless_arg: null,
    };
    const client = { beta: { messages: { parse: async () => ({ stop_reason: "end_turn", parsed_output: { invariants: [proposal], soft_rules: [] }, content: [] }) } } };
    const res = await draftInvariantsFromSop({ domain, sop, sopFile: "policy.md", fields: knownFields(domain, {}), claude: { client: client as unknown as Anthropic } });
    expect(res.invariants).toEqual([]);
    expect(res.warnings.join("\n")).toMatch(/dropped never-disclose-dnu: .*never_disclose can never fire on carriers\.do_not_use: it holds booleans/);
  });
});

describe("never_disclose never_with", () => {
  const parse = (never_with: unknown) => InvariantSpec.safeParse({ id: "x", description: "x", never_disclose: { table: "loads", field: "max_rate", never_with } }).success;

  it("takes a list of words, and rejects an empty list or an empty word", () => {
    expect(parse(["max", "ceiling", "top rate"])).toBe(true);
    expect(parse([])).toBe(false);
    expect(parse(["max", " "])).toBe(false);
    expect(parse("max")).toBe(false);
  });
});

describe("domainWarnings on never_disclose fields the agent is never shown", () => {
  const getLoad = (over: object = {}) => ToolSpec.parse({ name: "get_load", description: "Look up a load.", params: { load_id: { type: "string" } }, ops: [{ get: "loads", key: "$load_id" }], ...over });

  it("warns when no tool returns the table and the policy states none of its values", async () => {
    const d = withInvariant(await freight(), protect("loads", "max_rate"));
    expect(validateDomain(d)).toEqual([]);
    expect(domainWarnings(d)).toEqual([expect.stringMatching(/^invariants\.protect-max_rate: never_disclose can't fire on loads\.max_rate: no tool returns a loads record .*return the field from a tool, or state the value in the policy/)]);
  });

  it("is quiet once a tool returns the table, or the policy states a value", async () => {
    const d = withInvariant(await freight(), protect("loads", "max_rate"));
    expect(domainWarnings({ ...d, tools: [...d.tools, getLoad()] })).toEqual([]);
    // A tool that lists the rows, or returns them from a later op, shows them too; one that returns another op doesn't.
    expect(domainWarnings({ ...d, tools: [...d.tools, getLoad({ name: "list_loads", ops: [{ list: "loads" }] })] })).toEqual([]);
    expect(domainWarnings({ ...d, tools: [...d.tools, getLoad({ ops: [{ respond: "ok" }, { get: "loads", key: "$load_id" }], returns: 1 })] })).toEqual([]);
    expect(domainWarnings({ ...d, tools: [...d.tools, getLoad({ ops: [{ get: "loads", key: "$load_id" }, { respond: "ok" }], returns: 1 })] })).toHaveLength(1);
    expect(domainWarnings({ ...d, policy: `${d.policy} Never go above $2,350 on L-1001.` })).toEqual([]);
  });

  it("leaves fields validate already rejects to validate, and finds nothing to warn about in the bundled examples", async () => {
    expect(domainWarnings(withInvariant(await freight(), protect("carriers", "do_not_use")))).toEqual([]);
    for (const example of ["examples/freight", "examples/clinic"]) expect(domainWarnings(await loadDomain(example)), example).toEqual([]);
  });
});
