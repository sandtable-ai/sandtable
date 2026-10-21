import path from "node:path";
import { describe, expect, it } from "vitest";
import { lintDomain } from "../src/grade/lint.ts";
import { loadDomain } from "../src/spec/load.ts";
import { DomainSpec, type Task } from "../src/spec/schema.ts";

const example = path.resolve("examples/freight");
const user = { instructions: "x" };

describe("sandtable lint", () => {
  it("passes the freight example: write tasks solvable, refusal tasks recognised", async () => {
    const report = lintDomain(await loadDomain(example));
    expect(report.errors).toBe(0);
    expect(report.warnings).toBe(0);
    const byId = Object.fromEntries(report.tasks.map((t) => [t.id, t]));
    expect(byId["book-at-posted-rate"]).toMatchObject({ expectsWrite: true, solvable: true, noopPasses: false, ready: true });
    expect(byId["walk-away-above-ceiling"]).toMatchObject({ expectsWrite: false, noopPasses: true, solvable: null });
    // Every write task carries a reference that replays cleanly, and a do-nothing agent fails it.
    const writes = report.tasks.filter((t) => t.expectsWrite);
    expect(report.tasks).toHaveLength(50);
    expect(writes).toHaveLength(32);
    expect(writes.every((t) => t.solvable === true && !t.noopPasses)).toBe(true);
  });

  it("flags vacuous, unreachable, unsolvable and ungraded tasks", async () => {
    const d = await loadDomain(example);
    const tasks: Task[] = [
      { id: "vacuous", tags: [], user, expect: { state: [{ table: "loads", where: { status: "booked" }, count: 1 }], called: [], not_called: [], reply_includes: [] } },
      { id: "unreachable", tags: [], user, expect: { state: [{ table: "carriers", where: { mc_number: "999999" } }], called: [], not_called: [], reply_includes: [] } },
      {
        id: "bad-reference",
        tags: [],
        user,
        reference: [
          { tool: "verify_carrier", args: { mc_number: "100101" } },
          { tool: "book_load", args: { load_id: "L-1001", mc_number: "100101", rate: 2600 } },
        ],
        expect: { state: [{ table: "bookings", where: { load_id: "L-1001" }, count: 1 }], called: [], not_called: [], reply_includes: [] },
      },
      { id: "ungraded", tags: [], user, expect: { state: [], called: [], not_called: [], reply_includes: [] } },
    ];
    const report = lintDomain(DomainSpec.parse({ ...d, tasks }));
    const errors = Object.fromEntries(report.tasks.map((t) => [t.id, t.errors.join(" | ")]));
    expect(errors.vacuous).toMatch(/vacuous/);
    expect(errors.unreachable).toMatch(/needs a row in carriers that is not seeded and no tool can create or change/);
    expect(errors["bad-reference"]).toMatch(/reference does not pass: rate-ceiling/);
    expect(report.tasks.find((t) => t.id === "bad-reference")!.solvable).toBe(false);
    expect(errors.ungraded).toMatch(/nothing is graded/);
  });

  it("replays a reference call the API should reject, marked expect_error (#274)", async () => {
    const d = await loadDomain(example);
    const refusal = (id: string, reference: Task["reference"]): Task => ({
      id,
      tags: [],
      user,
      reference,
      expect: { state: [{ table: "bookings", count: 0 }], called: [], not_called: [], reply_includes: [] },
    });
    const unknown = { tool: "verify_carrier", args: { mc_number: "109999" } };
    const tasks: Task[] = [
      refusal("any-error", [{ ...unknown, expect_error: true }]),
      refusal("matching-error", [{ ...unknown, expect_error: "NOT FOUND" }]),
      refusal("unmarked-failure", [unknown]),
      refusal("expected-failure-succeeds", [{ tool: "verify_carrier", args: { mc_number: "100101" }, expect_error: true }]),
      refusal("other-error", [{ ...unknown, expect_error: "insurance" }]),
      refusal("invalid-arguments", [{ tool: "verify_carrier", args: {}, expect_error: true }]),
      refusal("explicitly-succeeds", [{ tool: "verify_carrier", args: { mc_number: "100101" }, expect_error: false }]),
    ];
    const report = lintDomain(DomainSpec.parse({ ...d, tasks }));
    const byId = Object.fromEntries(report.tasks.map((t) => [t.id, t]));
    expect(byId["any-error"]).toMatchObject({ solvable: true, errors: [] });
    expect(byId["matching-error"]).toMatchObject({ solvable: true, errors: [] });
    expect(byId["explicitly-succeeds"]).toMatchObject({ solvable: true, errors: [] });
    expect(byId["unmarked-failure"]!.errors).toEqual(["reference[0] verify_carrier failed: carriers 109999 not found"]);
    expect(byId["expected-failure-succeeds"]!.errors).toEqual(["reference[0] verify_carrier succeeded, but its expect_error says the API rejects it"]);
    expect(byId["other-error"]!.errors).toEqual([
      'reference[0] verify_carrier failed with "carriers 109999 not found", but its expect_error wants an error containing "insurance"',
    ]);
    // A call the tool rejects for its arguments never counts as the API's rejection.
    expect(byId["invalid-arguments"]!.errors).toEqual(['reference[0] verify_carrier: invalid arguments: missing required argument "mc_number"']);
    for (const id of ["unmarked-failure", "expected-failure-succeeds", "other-error", "invalid-arguments"]) expect(byId[id]!.solvable, id).toBe(false);
    expect(DomainSpec.safeParse({ ...d, tasks: [refusal("empty", [{ ...unknown, expect_error: " " }])] }).success).toBe(false);
  });

  it("reads argument matchers: a write expected through one, and a reference replay graded against them", async () => {
    const d = await loadDomain(example);
    const reference = [
      { tool: "verify_carrier", args: { mc_number: "100101" } },
      { tool: "book_load", args: { load_id: "L-1001", mc_number: "100101", rate: 2100 } },
    ];
    const book = (load_id: string): Task => ({
      id: `book-${load_id}`,
      tags: [],
      user,
      reference,
      expect: { state: [], called: [{ tool: "book_load", args: { load_id } }], not_called: [{ tool: "book_load", args: { rate: { $gt: 2200 } } }], reply_includes: [] },
    });
    const report = lintDomain(DomainSpec.parse({ ...d, tasks: [book("L-1001"), book("L-1003")] }));
    const [right, wrong] = report.tasks;
    expect(right).toMatchObject({ expectsWrite: true, solvable: true, noopPasses: false, errors: [] });
    expect(wrong).toMatchObject({ expectsWrite: true, solvable: false });
    expect(wrong!.errors).toEqual(['reference does not pass: called:book_load(load_id="L-1003"): book_load succeeded 1x, never with matching arguments: load_id is "L-1001", expected "L-1003"']);
  });
});
