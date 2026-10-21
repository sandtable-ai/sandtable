import { describe, expect, it } from "vitest";
import { matches, pruneUndefined, resolve } from "../src/world/match.ts";
import { diffSnapshots, World } from "../src/world/store.ts";
import { coerceArgs, executeTool, toolSchema } from "../src/world/tools.ts";
import { ToolSpec, type Tool } from "../src/spec/schema.ts";

const world = () =>
  new World({
    tables: {
      loads: {
        key: "load_id",
        rows: [
          { load_id: "L-1", origin: "Dallas, TX", status: "available", max_rate: 2000 },
          { load_id: "L-2", origin: "Chicago, IL", status: "booked", max_rate: 900 },
        ],
      },
      bookings: { key: "booking_id", rows: [] },
    },
  });

const book: Tool = ToolSpec.parse({
  name: "book_load",
  description: "Book a load",
  params: { load_id: { type: "string" }, rate: { type: "number" } },
  checks: [{ table: "loads", key: "$load_id", where: { status: "available" }, error: "Load ${load_id} is not available" }],
  ops: [
    { create: "bookings", values: { load_id: "$load_id", rate: "$rate" } },
    { update: "loads", key: "$load_id", set: { status: "booked" } },
  ],
});

describe("match", () => {
  it("resolves whole and inline references", () => {
    expect(resolve({ a: "$x", b: "id ${x}", c: ["$y"] }, { x: 7, y: "z" })).toEqual({ a: 7, b: "id 7", c: ["z"] });
  });

  it("leaves strings that are not references as they are, and only reads arguments that were passed", () => {
    const literals = ["$$", "$$$", "$/hr", "$USD/kg", "$€", "$5", "$@id", "${}", "$ {x}"];
    expect(resolve(literals, {})).toEqual(literals);
    expect(resolve({ a: "$constructor", b: "id ${toString}" }, {})).toEqual({ a: undefined, b: "id " });
  });

  it("supports operators", () => {
    const row = { rate: 2100, origin: "Dallas, TX", tags: null };
    expect(matches(row, { rate: { $gte: 2000, $lte: 2200 } })).toBe(true);
    expect(matches(row, { origin: { $contains: "dallas" } })).toBe(true);
    expect(matches(row, { rate: { $in: [1, 2] } })).toBe(false);
    expect(matches(row, { tags: { $exists: false } })).toBe(true);
    expect(matches(row, { rate: { $ne: 2100 } })).toBe(false);
  });

  it("matches a number to a string with the same digits, but not to zero-padded IDs", () => {
    expect(matches({ mc: "100101" }, { mc: 100101 })).toBe(true);
    expect(matches({ mc: 100101 }, { mc: "100101" })).toBe(true);
    expect(matches({ id: "00123" }, { id: 123 })).toBe(false);
    expect(matches({ rate: 2100 }, { rate: { $in: ["2100"] } })).toBe(true);
  });

  it("prunes conditions on unset optional params", () => {
    expect(pruneUndefined({ a: undefined, b: { $contains: undefined }, c: 1 })).toEqual({ c: 1 });
  });
});

describe("World", () => {
  it("inserts with generated keys and diffs snapshots", () => {
    const w = world();
    const before = w.snapshot();
    const row = w.insert("bookings", { load_id: "L-1" });
    expect(row.booking_id).toBe("bookings-1");
    w.update("loads", "L-1", { status: "booked" });
    const changes = diffSnapshots(before, w.snapshot(), { loads: "load_id", bookings: "booking_id" });
    expect(changes.map((c) => `${c.kind}:${c.table}:${c.key}`)).toEqual(["update:loads:L-1", "insert:bookings:bookings-1"]);
  });

  it("returns copies, so callers cannot mutate state", () => {
    const w = world();
    w.get("loads", "L-1")!.status = "hacked";
    expect(w.get("loads", "L-1")!.status).toBe("available");
  });
});

describe("tools", () => {
  it("builds a JSON schema with required params", () => {
    expect(toolSchema(book).input_schema).toMatchObject({ required: ["load_id", "rate"], additionalProperties: false });
  });

  it("coerces representations but rejects unknown or missing args", () => {
    expect(coerceArgs(book, { load_id: 1, rate: "$2,100" })).toEqual({ args: { load_id: "1", rate: 2100 } });
    expect(coerceArgs(book, { load_id: "L-1" })).toEqual({ error: 'missing required argument "rate"' });
    expect(coerceArgs(book, { load_id: "L-1", rate: 1, tip: 5 })).toEqual({ error: 'unknown argument "tip"' });
  });

  it("rejects an argument named like an Object.prototype member as unknown", () => {
    for (const name of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      // Parsed from JSON, as an agent's arguments are, so "__proto__" is an own key.
      const raw = JSON.parse(`{ "load_id": "L-1", "rate": 1, "${name}": "x" }`) as unknown;
      expect(coerceArgs(book, raw)).toEqual({ error: `unknown argument "${name}"` });
    }
  });

  it("reads only the arguments the agent passed, even for a param named like an Object.prototype member", () => {
    const tool: Tool = ToolSpec.parse({
      name: "label",
      description: "Label a load",
      params: { toString: { type: "string", required: false }, constructor: { type: "string", required: false, default: "manual" } },
      ops: [{ get: "loads", key: "L-1" }],
    });
    expect(coerceArgs(tool, {})).toEqual({ args: { constructor: "manual" } });
    expect(coerceArgs(tool, { toString: "a", constructor: "b" })).toEqual({ args: { toString: "a", constructor: "b" } });
  });

  it("applies param defaults when the agent omits an optional param", () => {
    const search: Tool = ToolSpec.parse({
      name: "search",
      description: "Search loads",
      params: { status: { type: "string", required: false, default: "available" } },
      ops: [{ list: "loads", where: { status: "$status" } }],
    });
    const out = executeTool(search, world(), (coerceArgs(search, {}) as { args: Record<string, unknown> }).args);
    expect((out.result as unknown[]).length).toBe(1);
    expect(toolSchema(search).input_schema.properties.status).toMatchObject({ default: "available" });
  });

  it("skips checks keyed by an optional argument that was not passed", () => {
    const note: Tool = ToolSpec.parse({
      name: "note",
      description: "Leave a note, optionally about a load",
      params: { text: { type: "string" }, load_id: { type: "string", required: false } },
      checks: [{ table: "loads", key: "$load_id", error: "no such load" }],
      ops: [{ respond: "ok" }],
    });
    expect(executeTool(note, world(), { text: "hi" })).toEqual({ ok: true, result: "ok" });
    expect(executeTool(note, world(), { text: "hi", load_id: "L-9" })).toEqual({ ok: false, error: "no such load" });
  });

  it("runs ops and returns the first result", () => {
    const w = world();
    const out = executeTool(book, w, { load_id: "L-1", rate: 1900 });
    expect(out).toEqual({ ok: true, result: { load_id: "L-1", rate: 1900, booking_id: "bookings-1" } });
    expect(w.get("loads", "L-1")!.status).toBe("booked");
  });

  it("fails checks without writing", () => {
    const w = world();
    expect(executeTool(book, w, { load_id: "L-2", rate: 800 })).toEqual({ ok: false, error: "Load L-2 is not available" });
    expect(w.list("bookings")).toEqual([]);
  });

  it("rolls back earlier ops when a later op fails", () => {
    const broken: Tool = ToolSpec.parse({
      ...book,
      checks: [],
      ops: [book.ops[0], { update: "loads", key: "L-404", set: { status: "booked" } }],
    });
    const w = world();
    expect(executeTool(broken, w, { load_id: "L-1", rate: 1 })).toEqual({ ok: false, error: "loads L-404 not found" });
    expect(w.list("bookings")).toEqual([]);
  });
});
