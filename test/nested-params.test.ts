import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { lintDomain } from "../src/grade/lint.ts";
import { draftFromOpenApi } from "../src/init/openapi.ts";
import { renderDraft } from "../src/init/render.ts";
import { describeTools } from "../src/init/sop.ts";
import { runSuite } from "../src/run/suite.ts";
import { bedrockConverseAgent, type ConverseClient } from "../src/sim/bedrock-converse.ts";
import { openaiCompatAgent } from "../src/sim/openai-compat.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import type { AgentAdapter } from "../src/sim/types.ts";
import { DomainError, loadDomain } from "../src/spec/load.ts";
import { DomainSpec, type Domain, type Tool } from "../src/spec/schema.ts";
import { matches, mismatch, operatorProblems, resolve } from "../src/world/match.ts";
import { coerceArgs, toolSchema } from "../src/world/tools.ts";

// A fictional garden supply shop whose order tool takes line items, an address and a note that can be cleared.

const SHOP = `
name: fernhollow-garden-supply
policy: Take orders for seeds and tools. Read the order back before you place it.
world:
  tables:
    products:
      key: sku
      rows:
        - { sku: SEED-TOM, name: Tomato seeds, price: 3 }
        - { sku: TOOL-TRW, name: Hand trowel, price: 12 }
    orders:
      key: order_id
tools:
  - name: create_order
    description: Place an order.
    params:
      order_id: { type: string }
      items:
        type: array
        description: Line items on the order
        items:
          type: object
          properties:
            sku: { type: string }
            qty: { type: integer }
            gift_note: { type: string, required: false }
      address:
        type: object
        properties:
          street: { type: string }
          zip: { type: string }
      note: { type: string, required: false, nullable: true }
    checks:
      - { table: products, key: $items.0.sku, error: "Unknown product \${items.0.sku}" }
    ops:
      - create: orders
        values: { order_id: $order_id, items: $items, address: $address, zip: $address.zip, note: $note, label: "Ship to \${address.zip}" }
tasks:
  - id: two-packets-and-a-trowel
    user:
      instructions: You are Sasha. Order 2 packets of tomato seeds and a trowel, shipped to 4 Elm Row, 94105.
      script: ["Two packets of tomato seeds and a trowel to 4 Elm Row, 94105, please."]
    reference:
      - { tool: create_order, args: { order_id: O-1, items: [{ sku: SEED-TOM, qty: 2 }, { sku: TOOL-TRW, qty: 1 }], address: { street: 4 Elm Row, zip: "94105" } } }
    expect:
      state:
        - { table: orders, where: { address.zip: "94105", items: { $contains: { sku: SEED-TOM, qty: { $gte: 2 } } } }, count: 1 }
      called:
        - { tool: create_order, args: { items: { $contains: { sku: SEED-TOM, qty: 2 } }, address.zip: "94105" } }
`;

function writeDomain(text: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sandtable-nested-"));
  writeFileSync(path.join(dir, "sandtable.yaml"), text);
  return dir;
}

const shop = () => loadDomain(writeDomain(SHOP));
const orderTool = async (): Promise<Tool> => (await shop()).tools[0]!;

describe("nested params: coercion", () => {
  it("coerces line items, an address and a nullable note, leniently as scalars are", async () => {
    const tool = await orderTool();
    const out = coerceArgs(tool, { order_id: "O-1", items: [{ sku: "SEED-TOM", qty: "2" }], address: { street: "4 Elm Row", zip: 94105 } });
    expect(out).toEqual({ args: { order_id: "O-1", items: [{ sku: "SEED-TOM", qty: 2 }], address: { street: "4 Elm Row", zip: "94105" } } });
  });

  it("parses an object or a list a model sent as a JSON string", async () => {
    const tool = await orderTool();
    const out = coerceArgs(tool, { order_id: "O-1", items: '[{"sku":"TOOL-TRW","qty":1}]', address: '{"street":"4 Elm Row","zip":"94105"}' });
    expect(out).toEqual({ args: { order_id: "O-1", items: [{ sku: "TOOL-TRW", qty: 1 }], address: { street: "4 Elm Row", zip: "94105" } } });
  });

  it("names the path of what's wrong", async () => {
    const tool = await orderTool();
    const base = { order_id: "O-1", address: { street: "4 Elm Row", zip: "94105" } };
    expect(coerceArgs(tool, { ...base, items: [{ sku: "A", qty: 1 }, { sku: "B", qty: 1.5 }] })).toEqual({ error: 'argument "items[1].qty" must be an integer' });
    expect(coerceArgs(tool, { ...base, items: [{ sku: "A", qty: 1, colour: "red" }] })).toEqual({ error: 'unknown argument "items[0].colour"' });
    expect(coerceArgs(tool, { ...base, items: [{ qty: 1 }] })).toEqual({ error: 'missing required argument "items[0].sku"' });
    expect(coerceArgs(tool, { ...base, items: { sku: "A", qty: 1 } })).toEqual({ error: 'argument "items" must be an array' });
    expect(coerceArgs(tool, { order_id: "O-1", items: [], address: "4 Elm Row" })).toEqual({ error: 'argument "address" must be an object' });
    expect(coerceArgs(tool, { order_id: "O-1", items: [], address: { street: "4 Elm Row" } })).toEqual({ error: 'missing required argument "address.zip"' });
    expect(coerceArgs(tool, { ...base, items: [null] })).toEqual({ error: 'argument "items[0]" is missing' });
  });

  it("keeps an explicit null for a nullable param, and leaves an omitted one out", async () => {
    const tool = await orderTool();
    const base = { order_id: "O-1", items: [], address: { street: "4 Elm Row", zip: "94105" } };
    expect(coerceArgs(tool, { ...base, note: null })).toEqual({ args: { ...base, note: null } });
    expect(coerceArgs(tool, base)).toEqual({ args: base });
    // Without nullable, null still means the argument was left out.
    expect(coerceArgs(tool, { ...base, order_id: null })).toEqual({ error: 'missing required argument "order_id"' });
  });

  it("tells a model that leaves out a required nullable param, or sends \"\", that it may be null", async () => {
    const tool = await orderTool();
    const required = { ...tool, params: { ...tool.params, note: { ...tool.params.note!, required: true } } };
    const base = { order_id: "O-1", items: [], address: { street: "4 Elm Row", zip: "94105" } };
    for (const args of [base, { ...base, note: "" }]) {
      expect(coerceArgs(required, args)).toEqual({ error: 'missing required argument "note" (it may be null)' });
    }
    expect(coerceArgs(required, { ...base, note: null })).toEqual({ args: { ...base, note: null } });
  });
});

describe("nested params: tool schemas", () => {
  it("sends agents nested JSON Schema", async () => {
    expect(toolSchema(await orderTool()).input_schema).toEqual({
      type: "object",
      properties: {
        order_id: { type: "string" },
        items: {
          type: "array",
          description: "Line items on the order",
          items: {
            type: "object",
            properties: { sku: { type: "string" }, qty: { type: "integer" }, gift_note: { type: "string" } },
            required: ["sku", "qty"],
            additionalProperties: false,
          },
        },
        address: { type: "object", properties: { street: { type: "string" }, zip: { type: "string" } }, required: ["street", "zip"], additionalProperties: false },
        note: { type: ["string", "null"] },
      },
      required: ["order_id", "items", "address"],
      additionalProperties: false,
    });
  });

  it("leaves the bundled examples' tool schemas, and so their inputs hashes, as they were", async () => {
    // The hash of each example's tool schemas before params could nest. Change it only with a deliberate change to a tool.
    const hash = (d: Domain) => createHash("sha256").update(JSON.stringify(d.tools.map(toolSchema))).digest("hex").slice(0, 16);
    expect(hash(await loadDomain("examples/freight"))).toBe("b36142c1ed4285a5");
    expect(hash(await loadDomain("examples/clinic"))).toBe("f1a0f1e2192e5c9c");
  });
});

describe("nested params: templates", () => {
  const params = { address: { type: "object" }, items: { type: "array" }, rate: { type: "number" } };
  const args = { address: { street: "4 Elm Row", zip: "94105" }, items: [{ sku: "SEED-TOM", qty: 2 }], rate: 12 };

  it("read a field of an object or an element of a list", () => {
    expect(resolve("$address.zip", args, params)).toBe("94105");
    expect(resolve("Ship to ${address.zip}", args, params)).toBe("Ship to 94105");
    expect(resolve("$items.0.sku", args, params)).toBe("SEED-TOM");
    expect(resolve("$items", args, params)).toEqual(args.items);
    expect(resolve("$items.3.sku", args, params)).toBeUndefined();
  });

  it("keep a path after any other param, or after no param, as the literal text it always was", () => {
    expect(resolve("$rate.00", args, params)).toBe("$rate.00");
    expect(resolve("Costs ${rate.00}", args, params)).toBe("Costs ${rate.00}");
    expect(resolve("$domain.com", args, params)).toBe("$domain.com");
  });
});

describe("nested params: where clauses", () => {
  const row = { order_id: "O-1", address: { zip: "94105" }, items: [{ sku: "SEED-TOM", qty: 2 }, { sku: "TOOL-TRW", qty: 1 }], tags: ["gift", "rush"], "a.b": "literal" };

  it("read a dotted field inside a row, after a field with that literal name", () => {
    expect(matches(row, { "address.zip": "94105" })).toBe(true);
    expect(matches(row, { "address.zip": { $ne: "94105" } })).toBe(false);
    expect(matches(row, { "a.b": "literal" })).toBe(true);
    expect(matches(row, { "items.1.sku": "TOOL-TRW" })).toBe(true);
    expect(mismatch(row, { "address.zip": "10001" })).toBe('address.zip is "94105", expected "10001"');
  });

  it("$contains finds a matching element: a partial object with operators, or a value", () => {
    expect(matches(row, { items: { $contains: { sku: "SEED-TOM", qty: { $gte: 2 } } } })).toBe(true);
    expect(matches(row, { items: { $contains: { sku: "SEED-TOM", qty: 3 } } })).toBe(false);
    expect(matches(row, { tags: { $contains: "rush" } })).toBe(true);
    expect(matches(row, { tags: { $contains: "rus" } })).toBe(false);
    expect(matches({ qtys: [1, 5] }, { qtys: { $contains: { $gt: 4 } } })).toBe(true);
    // On text, it still finds a substring, ignoring case.
    expect(matches({ name: "Hand trowel" }, { name: { $contains: "TROWEL" } })).toBe(true);
  });

  it("validate checks the operators inside $contains", () => {
    expect(operatorProblems({ items: { $contains: { qty: { $atleast: 2 } } } })).toEqual(['items.$contains.qty: unknown operator "$atleast" (use $eq, $ne, $in, $nin, $gt, $gte, $lt, $lte, $exists, $contains)']);
    expect(operatorProblems({ qtys: { $contains: { $over: 4 } } })).toEqual(['qtys: unknown operator "$over" (use $eq, $ne, $in, $nin, $gt, $gte, $lt, $lte, $exists, $contains)']);
  });
});

describe("nested params: validate", () => {
  const problems = async (text: string) => ((await loadDomain(writeDomain(text)).catch((e: unknown) => e)) as Error).message;
  const withParam = (param: string) => SHOP.replace("      note: { type: string, required: false, nullable: true }", `      note: ${param}`);

  it("loads the shop", async () => {
    await expect(shop()).resolves.toMatchObject({ name: "fernhollow-garden-supply" });
  });

  it("rejects an object without properties, an array without items, and fields on the wrong type", async () => {
    expect(await problems(withParam("{ type: object }"))).toContain("an object param needs properties");
    expect(await problems(withParam("{ type: array }"))).toContain("an array param needs items");
    expect(await problems(withParam("{ type: string, items: { type: string } }"))).toContain("items are only for an array param, not a string");
    expect(await problems(withParam("{ type: object, enum: [a], properties: { a: { type: string } } }"))).toContain("enum is only for a scalar param");
    expect(await problems(withParam("{ type: array, items: { type: string, required: false } }"))).toContain("an array's items have no required of their own");
    expect(await problems(withParam("{ type: array, items: { type: string, default: x } }"))).toContain("an array's items have no default of their own");
  });

  it("checks defaults that only nested and nullable params can have", async () => {
    expect(await problems(withParam("{ type: string, required: false, default: null }"))).toContain("tools.create_order.params.note.default: null needs nullable: true");
    expect(await problems(withParam("{ type: string, required: false, default: [a] }"))).toContain("a string param can't default to a list");
    expect(await problems(withParam("{ type: array, required: false, items: { type: integer }, default: [1, x] }"))).toContain('params.note.default: argument "note[1]" must be an integer');
    await expect(loadDomain(writeDomain(withParam("{ type: array, required: false, items: { type: integer }, default: [1, 2] }")))).resolves.toBeDefined();
  });

  it("checks a nested argument named in a task's expectations or a template", async () => {
    const msg = await problems(SHOP.replace('args: { items: { $contains: { sku: SEED-TOM, qty: 2 } }, address.zip: "94105" }', 'args: { address.postcode: "94105" }'));
    expect(msg).toContain('tasks.two-packets-and-a-trowel.expect.called[0]: tool "create_order" has no param "address.postcode"');
    expect(await problems(SHOP.replace("zip: $address.zip,", "zip: $address.postcode,"))).toContain('"$address.postcode" never resolves: param "address" has no "postcode"');
    // A path after a scalar param is literal text, as before params could nest.
    await expect(loadDomain(writeDomain(SHOP.replace('label: "Ship to ${address.zip}"', 'label: "$order_id.pdf"')))).resolves.toBeDefined();
  });

  it("rejects a bad operator inside $contains", async () => {
    const err = await loadDomain(writeDomain(SHOP.replace("qty: { $gte: 2 }", "qty: { $atleast: 2 }"))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as Error).message).toContain('items.$contains.qty: unknown operator "$atleast"');
  });
});

describe("nested params: a run", () => {
  /** Places the order the caller asks for, as a JSON string for the items, as some models send it. */
  const clerk: AgentAdapter = {
    name: "clerk",
    async createSession() {
      return {
        async reply(_message, callTool) {
          const out = await callTool("create_order", {
            order_id: "O-7",
            items: JSON.stringify([{ sku: "SEED-TOM", qty: 2 }, { sku: "TOOL-TRW", qty: 1 }]),
            address: { street: "4 Elm Row", zip: "94105" },
          });
          return out.ok ? "Your order O-7 is placed." : `Sorry: ${out.error}`;
        },
      };
    },
  };

  it("grades line items with $contains and a dotted field, and lint replays the reference", async () => {
    const domain = await shop();
    expect(lintDomain(domain).tasks[0]).toMatchObject({ ready: true, solvable: true });
    const r = await runSuite({ domain, agent: clerk, user: scriptedUser() });
    const trial = r.tasks[0]!.trials[0]!;
    expect(trial.checks.filter((c) => !c.passed)).toEqual([]);
    expect(trial.passed).toBe(true);
    expect(trial.changes).toEqual([
      {
        table: "orders",
        key: "O-7",
        kind: "insert",
        after: expect.objectContaining({ zip: "94105", label: "Ship to 94105", items: [{ sku: "SEED-TOM", qty: 2 }, { sku: "TOOL-TRW", qty: 1 }] }),
      },
    ]);
  });

  it("fails a run whose items don't match", async () => {
    const domain = await shop();
    const short: AgentAdapter = {
      name: "short",
      async createSession() {
        return {
          async reply(_m, callTool) {
            await callTool("create_order", { order_id: "O-8", items: [{ sku: "SEED-TOM", qty: 1 }], address: { street: "4 Elm Row", zip: "94105" } });
            return "Done.";
          },
        };
      },
    };
    const trial = (await runSuite({ domain, agent: short, user: scriptedUser() })).tasks[0]!.trials[0]!;
    expect(trial.passed).toBe(false);
    expect(trial.checks.filter((c) => !c.passed).map((c) => c.kind)).toEqual(["state", "called"]);
  });

  it("refuses a check whose nested key names an unknown product", async () => {
    const domain = await shop();
    const r = await runSuite({
      domain,
      user: scriptedUser(),
      agent: {
        name: "typo",
        async createSession() {
          return {
            async reply(_m, callTool) {
              const out = await callTool("create_order", { order_id: "O-9", items: [{ sku: "SEED-XXX", qty: 1 }], address: { street: "4 Elm Row", zip: "94105" } });
              return out.error ?? "ok";
            },
          };
        },
      },
    });
    expect(r.tasks[0]!.trials[0]!.events.find((e) => e.type === "tool")).toMatchObject({ ok: false, error: "Unknown product SEED-XXX" });
  });
});

describe("nested params: init --openapi", () => {
  // A fictional nursery's order API with a line-items body.
  const spec = {
    openapi: "3.0.3",
    info: { title: "Fernhollow Orders" },
    paths: {
      "/orders": {
        post: {
          operationId: "createOrder",
          requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/NewOrder" } } } },
          responses: { "201": { description: "created" } },
        },
      },
    },
    components: {
      schemas: {
        NewOrder: {
          type: "object",
          required: ["items", "address"],
          properties: {
            items: { type: "array", description: "Line items", items: { $ref: "#/components/schemas/LineItem" } },
            address: { $ref: "#/components/schemas/Address" },
            payment: { oneOf: [{ type: "string" }, { type: "object", properties: { card: { type: "string" } } }] },
            deep: { type: "object", properties: { a: { type: "object", properties: { b: { type: "object", properties: { c: { type: "object", properties: { d: { type: "string" } } } } } } } } },
          },
        },
        LineItem: { type: "object", required: ["sku", "qty"], properties: { sku: { type: "string" }, qty: { type: "integer" }, note: { type: "string" } } },
        Address: { type: "object", required: ["zip"], properties: { street: { type: "string" }, zip: { type: "string" } } },
      },
    },
  };

  it("drafts an object and a list of objects as nested params, and skips what it can't map", () => {
    const d = draftFromOpenApi(spec);
    const create = d.tools[0]!;
    expect(create.params.items).toEqual({
      type: "array",
      required: true,
      description: "Line items",
      items: { type: "object", required: true, properties: { sku: { type: "string", required: true }, qty: { type: "integer", required: true }, note: { type: "string", required: false } } },
    });
    expect(create.params.address).toEqual({ type: "object", required: true, properties: { street: { type: "string", required: false }, zip: { type: "string", required: true } } });
    // oneOf has no single type, so it drafts as a string, as before; four levels of objects is one too many.
    expect(create.params.payment).toMatchObject({ type: "string" });
    expect(create.params).not.toHaveProperty("deep");
    expect(d.warnings).toContain('POST /orders: body field "deep" has a schema init can\'t map; skipped');
    expect(create.ops).toEqual([{ create: "orders", values: { items: "$items", address: "$address", payment: "$payment" } }]);
  });

  it("shows the drafting model an item's fields", async () => {
    expect(describeTools(await shop())).toContain(
      "- create_order(order_id: string, items: {sku: string, qty: integer, gift_note?: string}[], address: {street: string, zip: string}, note?: string or null): Place an order.",
    );
  });

  it("renders a draft that loads and validates", async () => {
    const text = renderDraft(draftFromOpenApi(spec), "openapi.yaml");
    const raw = YAML.parse(text) as Record<string, unknown>;
    expect((raw.tools as { params: Record<string, unknown> }[])[0]!.params.items).toEqual({
      type: "array",
      description: "Line items",
      items: { type: "object", properties: { sku: { type: "string" }, qty: { type: "integer" }, note: { type: "string", required: false } } },
    });
    expect(text).toContain("sku: { type: string }");
    const parsed = DomainSpec.safeParse({ ...raw, policy: "Take orders.", tasks: [] });
    expect(parsed.success).toBe(true);
  });
});

describe("nested params: adapters send the schema as it is", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("openai: and bedrock: pass the nested schema through unchanged", async () => {
    const domain = await shop();
    const tools = domain.tools.map(toolSchema);
    const ctx = { domain, system: "policy", tools, sessionId: "s1" };

    const bodies: { tools: { function: { parameters: unknown } }[] }[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      const message = { role: "assistant", content: "Placed." };
      return new Response(JSON.stringify({ choices: [{ index: 0, message, finish_reason: "stop" }] }), { status: 200 });
    });
    await (await openaiCompatAgent({ baseUrl: "http://llm.local/v1", model: "m" }).createSession(ctx)).reply("Order, please.", async () => ({ ok: true }));
    expect(bodies[0]!.tools[0]!.function.parameters).toEqual(tools[0]!.input_schema);

    const sent: { toolConfig: { tools: { toolSpec: { inputSchema: { json: unknown } } }[] } }[] = [];
    const client: ConverseClient = {
      async send(cmd) {
        sent.push(structuredClone(cmd as never));
        return { stopReason: "end_turn", output: { message: { role: "assistant", content: [{ text: "Placed." }] } } } as never;
      },
    };
    await (await bedrockConverseAgent({ modelId: "m", client }).createSession(ctx)).reply("Order, please.", async () => ({ ok: true }));
    expect(sent[0]!.toolConfig.tools[0]!.toolSpec.inputSchema.json).toEqual(tools[0]!.input_schema);
  });
});
