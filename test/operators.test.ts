import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadDomain, validateDomain } from "../src/spec/load.ts";
import { DomainSpec, type Domain } from "../src/spec/schema.ts";
import { matches, OPERATORS, operatorProblems } from "../src/world/match.ts";

// An unknown operator, or `$in`/`$nin` without a list, in any where clause fails `validate` with its
// path, instead of throwing mid-run or silently matching nothing.

const USE = `(use ${OPERATORS.join(", ")})`;

/** A tiny fictional domain whose where clauses are all valid; each test breaks one of them. */
function domain(edit: (raw: Record<string, any>) => void = () => {}): Domain {
  const raw: Record<string, any> = {
    name: "orders-desk",
    policy: "Close open orders when asked.",
    world: { tables: { orders: { key: "id", rows: [{ id: "O-1", status: "open" }, { id: "O-2", status: "closed" }] } } },
    tools: [
      {
        name: "list_orders",
        description: "List orders by status.",
        params: { status: { type: "string" } },
        ops: [{ list: "orders", where: { status: { $eq: "$status" } } }],
      },
      {
        name: "close_order",
        description: "Close an order.",
        params: { id: { type: "string" } },
        checks: [{ table: "orders", key: "$id", where: { status: { $in: ["open"] } }, error: "not open" }],
        ops: [{ update: "orders", key: "$id", set: { status: "closed" } }],
      },
    ],
    invariants: [
      { id: "only-open", description: "Only open orders are closed.", require: { tool: "close_order", table: "orders", key_arg: "id", where: { status: { $ne: "closed" } } } },
      { id: "never-o2", description: "Never touch O-2.", never: { tool: "close_order", when: { id: { $in: ["O-2"] } } } },
    ],
    tasks: [
      {
        id: "close-o1",
        user: { instructions: "Close O-1.", script: ["Close O-1."] },
        expect: { state: [{ table: "orders", where: { status: { $contains: "close" } } }, { table: "orders", key: "O-1", fields: { status: { $nin: ["open"] } } }] },
      },
    ],
  };
  edit(raw);
  return DomainSpec.parse(raw);
}

describe("validate checks the operators of every where clause", () => {
  it("passes valid clauses, and the bundled examples", async () => {
    expect(validateDomain(domain())).toEqual([]);
    for (const example of ["freight", "clinic"]) {
      expect(validateDomain(await loadDomain(path.resolve("examples", example)))).toEqual([]);
    }
  });

  it.each([
    ["a tool's list op", (r: any) => (r.tools[0].ops[0].where = { status: { $equals: "$status" } }), `tools.list_orders.ops[0].where.status: unknown operator "$equals" ${USE}`],
    ["a tool's check", (r: any) => (r.tools[1].checks[0].where = { status: { $like: "open" } }), `tools.close_order.checks[0].where.status: unknown operator "$like" ${USE}`],
    ["a require invariant", (r: any) => (r.invariants[0].require.where = { status: { $regex: "^open" } }), `invariants.only-open.require.where.status: unknown operator "$regex" ${USE}`],
    ["a never invariant", (r: any) => (r.invariants[1].never.when = { id: { $neq: "O-1" } }), `invariants.never-o2.never.when.id: unknown operator "$neq" ${USE}`],
    ["a state assertion's where", (r: any) => (r.tasks[0].expect.state[0].where = { status: { $like: "closed" } }), `tasks.close-o1.expect.state[0].where.status: unknown operator "$like" ${USE}`],
    ["a state assertion's fields", (r: any) => (r.tasks[0].expect.state[1].fields = { status: { $not: "open" } }), `tasks.close-o1.expect.state[1].fields.status: unknown operator "$not" ${USE}`],
    ["a called entry's args", (r: any) => (r.tasks[0].expect.called = [{ tool: "close_order", args: { id: { $startsWith: "O-" } } }]), `tasks.close-o1.expect.called[0].args.id: unknown operator "$startsWith" ${USE}`],
  ])("rejects an unknown operator in %s, with its path", (_, edit, problem) => {
    expect(validateDomain(domain(edit))).toEqual([problem]);
  });

  it("rejects a name inherited from Object.prototype as unknown", () => {
    const d = domain((r) => (r.tools[1].checks[0].where = { status: { $constructor: "open" } }));
    expect(validateDomain(d)).toEqual([`tools.close_order.checks[0].where.status: unknown operator "$constructor" ${USE}`]);
  });

  it("rejects $in and $nin without a list, which would match nothing", () => {
    const d = domain((r) => {
      r.tools[1].checks[0].where = { status: { $in: "open" } };
      r.invariants[1].never.when = { id: { $nin: "O-1" } };
    });
    expect(validateDomain(d)).toEqual(["tools.close_order.checks[0].where.status: $in needs a list", "invariants.never-o2.never.when.id: $nin needs a list"]);
  });

  it("says a tool's argument is a single value, never the list $in needs", () => {
    const d = domain((r) => {
      r.tools[0].ops[0].where = { status: { $in: "$status" } };
      r.tools[1].checks[0].where = { id: { $nin: "$id" } };
    });
    expect(validateDomain(d)).toEqual([
      'tools.list_orders.ops[0].where.status: $in needs a list, and "$status" is a single argument value: list the values, or use $eq',
      'tools.close_order.checks[0].where.id: $nin needs a list, and "$id" is a single argument value: list the values, or use $ne',
    ]);
  });

  it("rejects a top-level operator such as $or, which no row has as a field", () => {
    const d = domain((r) => (r.tasks[0].expect.state[0].where = { $or: [{ status: "open" }, { status: "closed" }] }));
    expect(validateDomain(d)).toEqual(["tasks.close-o1.expect.state[0].where.$or: a where clause has no operators at the top, only fields, and all of them must hold"]);
  });
});

describe("matching", () => {
  it("knows exactly the operators validate accepts", () => {
    const row = { status: "open", rate: 2100 };
    for (const op of OPERATORS) expect(() => matches(row, { status: { [op]: ["open"] } })).not.toThrow();
    expect(() => matches(row, { status: { $like: "open" } })).toThrow("Unknown operator $like");
    expect(() => matches(row, { status: { $constructor: "open" } })).toThrow("Unknown operator $constructor");
    expect(operatorProblems({ status: { $eq: "open" }, rate: { $gte: 2000, $lte: 2200 } })).toEqual([]);
  });
});
