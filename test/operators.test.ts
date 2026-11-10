import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { domainWarnings, loadDomain, validateDomain } from "../src/spec/load.ts";
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
    ["a require invariant", (r: any) => (r.invariants[0].require.where = { status: { $like: "open" } }), `invariants.only-open.require.where.status: unknown operator "$like" ${USE}`],
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

  it("reports invalid regex patterns with the clause path", () => {
    const d = domain((r) => {
      r.tools[0].ops[0].where = { status: { $regex: "[" } };
      r.tasks[0].expect.state[1].fields = { status: { $regex: 1 } };
    });
    expect(validateDomain(d)).toEqual([
      'tools.list_orders.ops[0].where.status: invalid $regex pattern "["',
      "tasks.close-o1.expect.state[1].fields.status: $regex needs a string pattern",
    ]);
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

describe("validate warns about a condition that doesn't do what it says", () => {
  const mixed = (at: string, key: string, ops: string) =>
    `${at}: the plain key "${key}" beside ${ops} turns this object into an equality check, so no operator in it is read. Put a $ on "${key}" if it's an operator, or take it out; 2.0 will reject this.`;
  const exists = (at: string, literal: string, reads: boolean) => `${at}: $exists takes true or false, and ${literal} is read as ${reads}. Write true or false; 2.0 will reject this.`;
  const bare = (at: string, keys: string, ops: string) =>
    `${at}: { ${keys} } has no $, so it's compared by equality and never read as an operator. Did you mean ${ops}?`;
  const LIST = "tools.list_orders.ops[0].where.status";
  const STATE = "tasks.close-o1.expect.state[0].where";
  const COND = { $gte: 2000, lte: 2200 };

  /** A tool param to refer to, so "$flag" and "$flag.on" resolve: a path reaches into an object param, and stays text after any other. */
  const flag = { type: "object", properties: { on: { type: "boolean" } } };
  const withFlag = (r: any) => (r.tools[0].params.flag = flag);

  // Each place validate reads a where clause, as the list in the tests above and its max_count and not_called besides.
  const PLACES: [string, (r: any, cond: unknown) => void, string][] = [
    ["a tool's list op", (r, cond) => (r.tools[0].ops[0].where = { status: cond }), LIST],
    ["a tool's check", (r, cond) => (r.tools[1].checks[0].where = { status: cond }), "tools.close_order.checks[0].where.status"],
    ["a require invariant", (r, cond) => (r.invariants[0].require.where = { status: cond }), "invariants.only-open.require.where.status"],
    ["a never invariant", (r, cond) => (r.invariants[1].never.when = { id: cond }), "invariants.never-o2.never.when.id"],
    ["a max_count invariant", (r, cond) => r.invariants.push({ id: "few", description: "Few closes.", max_count: { tool: "close_order", max: 2, when: { id: cond } } }), "invariants.few.max_count.when.id"],
    ["a state assertion's where", (r, cond) => (r.tasks[0].expect.state[0].where = { status: cond }), `${STATE}.status`],
    ["a state assertion's fields", (r, cond) => (r.tasks[0].expect.state[1].fields = { status: cond }), "tasks.close-o1.expect.state[1].fields.status"],
    ["a called entry's args", (r, cond) => (r.tasks[0].expect.called = [{ tool: "close_order", args: { id: cond } }]), "tasks.close-o1.expect.called[0].args.id"],
    ["a not_called entry's args", (r, cond) => (r.tasks[0].expect.not_called = [{ tool: "close_order", args: { id: cond } }]), "tasks.close-o1.expect.not_called[0].args.id"],
  ];

  it.each(PLACES)("warns about operators mixed with a plain key in %s, and the domain stays valid", (_, put, at) => {
    const d = domain((r) => put(r, COND));
    expect(domainWarnings(d)).toEqual([mixed(at, "lte", "$gte")]);
    expect(validateDomain(d)).toEqual([]);
  });

  it.each(PLACES)("warns about bare operator names without $ in %s, and the domain stays valid", (_, put, at) => {
    const d = domain((r) => put(r, { gt: 2000 }));
    expect(domainWarnings(d)).toEqual([bare(at, "gt", "$gt")]);
    expect(validateDomain(d)).toEqual([]);
  });

  it("names every bare operator in an object", () => {
    const d = domain((r) => (r.tools[0].ops[0].where = { status: { gte: 2250, lte: 2350 } }));
    expect(domainWarnings(d)).toEqual([bare(LIST, "gte, lte", "$gte, $lte")]);
  });

  it.each(PLACES)("warns about a literal $exists in %s, and the domain stays valid", (_, put, at) => {
    const d = domain((r) => put(r, { $exists: "no" }));
    expect(domainWarnings(d)).toEqual([exists(at, '"no"', true)]);
    expect(validateDomain(d)).toEqual([]);
  });

  it.each([
    ["no", '"no"', true],
    ["false", '"false"', true],
    ["", '""', false],
    [1, "1", true],
    [0, "0", false],
    [null, "null", false],
    [[], "[]", true],
  ])("says what $exists: %j is read as", (value, literal, reads) => {
    expect(domainWarnings(domain((r) => (r.tools[0].ops[0].where = { status: { $exists: value } })))).toEqual([exists(LIST, literal, reads)]);
  });

  it("names every plain key and every operator of a mixed object", () => {
    const d = domain((r) => (r.tools[0].ops[0].where = { status: { $gt: 1, lte: 2, $ne: 3, nin: 4 } }));
    expect(domainWarnings(d)).toEqual([mixed(LIST, "lte", "$gt, $ne"), mixed(LIST, "nin", "$gt, $ne")]);
  });

  it("gives a mixed object that one warning, since none of its operators is read", () => {
    const d = domain((r) => (r.tools[0].ops[0].where = { status: { $exists: "no", lte: 2 } }));
    expect(domainWarnings(d)).toEqual([mixed(LIST, "lte", "$exists")]);
  });

  it("warns, and doesn't fail, on an unknown operator in a mixed object, which 1.4 accepted", () => {
    const d = domain((r) => (r.tools[0].ops[0].where = { status: { $like: "open", lte: 2 } }));
    expect(domainWarnings(d)).toEqual([mixed(LIST, "lte", "$like")]);
    expect(validateDomain(d)).toEqual([]);
  });

  it("reaches inside a $contains, with the path of the condition", () => {
    const warned = (cond: unknown) => domainWarnings(domain((r) => (r.tasks[0].expect.state[0].where = { items: cond })));
    expect(warned({ $contains: { qty: COND } })).toEqual([mixed(`${STATE}.items.$contains.qty`, "lte", "$gte")]);
    expect(warned({ $contains: { qty: { gt: 2000 } } })).toEqual([bare(`${STATE}.items.$contains.qty`, "gt", "$gt")]);
    expect(warned({ $contains: { note: { $exists: "no" } } })).toEqual([exists(`${STATE}.items.$contains.note`, '"no"', true)]);
    // A list inside an element, as a list of parts in each order.
    expect(warned({ $contains: { parts: { $contains: { qty: COND } } } })).toEqual([mixed(`${STATE}.items.$contains.parts.$contains.qty`, "lte", "$gte")]);
    // Operators on the element itself keep the field's path, as operator errors do.
    expect(warned({ $contains: { $exists: "no" } })).toEqual([exists(`${STATE}.items`, '"no"', true)]);
  });

  it("keeps failing a mixed object that is the $contains element itself, which 1.4 already rejected", () => {
    const d = domain((r) => (r.tasks[0].expect.state[0].where = { items: { $contains: COND } }));
    expect(validateDomain(d)).toEqual([`${STATE}.items.$contains.$gte: a where clause has no operators at the top, only fields, and all of them must hold`]);
  });

  it("leaves a $arg reference in a tool's clause alone, as a whole value or with a path", () => {
    for (const ref of ["$flag", "$flag.on"]) {
      const d = domain((r) => {
        withFlag(r);
        r.tools[0].ops[0].where = { status: { $exists: ref } };
        r.tools[1].params.flag = flag;
        r.tools[1].checks[0].where = { status: { $exists: ref } };
      });
      expect(domainWarnings(d), ref).toEqual([]);
    }
  });

  it('flags "${flag}" in a tool\'s clause, which is always text, so an argument of false still means true', () => {
    const d = domain((r) => {
      withFlag(r);
      r.tools[0].ops[0].where = { status: { $exists: "${flag}" } };
    });
    expect(domainWarnings(d)).toEqual([exists(LIST, '"${flag}"', true)]);
  });

  it('flags "$flag" outside a tool, where no argument replaces it', () => {
    const d = domain((r) => (r.invariants[1].never.when = { id: { $exists: "$flag" } }));
    expect(domainWarnings(d)).toEqual([exists("invariants.never-o2.never.when.id", '"$flag"', true)]);
  });

  it.each([
    ["$exists: true", { $exists: true }],
    ["$exists: false", { $exists: false }],
    ["all operators", { $gte: 2000, $lte: 2200 }],
    ["an equality on an object field", { zip: "94105" }],
    ["an object with other keys beside an operator name", { gt: 1, zip: 2 }],
    ["an empty object", {}],
    ["an object $eq compares whole", { $eq: { $gte: 2000, lte: 2200 } }],
    ["objects $in compares whole", { $in: [{ $gte: 2000, lte: 2200 }] }],
    ["a plain value", "open"],
  ])("has nothing to say about %s", (_, cond) => {
    const d = domain((r) => (r.tools[0].ops[0].where = { status: cond }));
    expect(domainWarnings(d)).toEqual([]);
    expect(validateDomain(d)).toEqual([]);
  });

  it("has nothing to say about the bundled examples", async () => {
    for (const example of ["freight", "clinic"]) expect(domainWarnings(await loadDomain(path.resolve("examples", example))), example).toEqual([]);
  });

  it.skipIf(!process.features.typescript)("validate prints them for a YAML file and exits 0, with or without --strict", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sandtable-operators-"));
    writeFileSync(
      path.join(dir, "sandtable.yaml"),
      `name: fernhill-parts
policy: Sell parts from the counter.
world:
  tables:
    parts:
      key: part_id
      rows:
        - { part_id: P-1, price: 2100 }
tools:
  - name: list_parts
    description: List parts in a price band.
    params: {}
    ops:
      - list: parts
        where: { price: { $gte: 2000, lte: 2200 } }
  - name: order
    description: Place an order.
    params:
      part_id: { type: string }
      note: { type: string, required: false }
    ops:
      - get: parts
        key: $part_id
invariants:
  - id: note-required
    description: An order needs a note.
    never: { tool: order, when: { note: { $exists: no } } }
  - id: cheap-parts
    description: Parts must stay cheap.
    never: { tool: order, when: { price: { gt: 2000 } } }
tasks:
  - id: t1
    user: { instructions: Order P-1., script: ["Order P-1"] }
    expect:
      state:
        - { table: parts, where: { price: { $exists: true } } }
`,
    );
    // Either exit other than 0 would reject here.
    for (const flags of [[], ["--strict"]]) {
      const { stdout } = await promisify(execFile)(process.execPath, [path.resolve("src/cli.ts"), "validate", dir, ...flags]);
      expect(stdout).toContain(`⚠ ${mixed("tools.list_parts.ops[0].where.price", "lte", "$gte")}`);
      expect(stdout).toContain(`⚠ ${exists("invariants.note-required.never.when.note", '"no"', true)}`);
      expect(stdout).toContain(`⚠ ${bare("invariants.cheap-parts.never.when.price", "gt", "$gt")}`);
    }
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

  it("compares an object that mixes operators with plain keys by equality, as 1.4 did", () => {
    expect(matches({ price: 2100 }, { price: { $gte: 2000, lte: 2200 } })).toBe(false);
    expect(matches({ price: { $gte: 2000, lte: 2200 } }, { price: { $gte: 2000, lte: 2200 } })).toBe(true);
  });

  it("reads a $exists that isn't true or false by whether it's truthy, as 1.4 did", () => {
    for (const truthy of ["no", "false", 1]) {
      expect(matches({ note: "x" }, { note: { $exists: truthy } }), String(truthy)).toBe(true);
      expect(matches({}, { note: { $exists: truthy } }), String(truthy)).toBe(false);
    }
    expect(matches({ note: "x" }, { note: { $exists: 0 } })).toBe(false);
    expect(matches({}, { note: { $exists: 0 } })).toBe(true);
  });
});
