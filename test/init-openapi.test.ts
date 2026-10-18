import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { draftFromOpenApi, singularize, snake } from "../src/init/openapi.ts";
import { DOMAIN_FILE, POLICY_PLACEHOLDER, renderDraft, TASKS_PLACEHOLDER, writeDraft } from "../src/init/render.ts";
import { loadDomain } from "../src/spec/load.ts";

const freightSpec = async () => YAML.parse(await readFile("examples/freight/source/openapi.yaml", "utf8")) as Record<string, unknown>;

describe("init from OpenAPI: freight spec", () => {
  it("maps resources to tables with keys from path params and schemas", async () => {
    const d = draftFromOpenApi(await freightSpec());
    expect(Object.fromEntries(Object.entries(d.tables).map(([n, t]) => [n, t.key]))).toEqual({
      bookings: "booking_id",
      carriers: "mc_number",
      escalations: "escalation_id",
      loads: "load_id",
    });
    expect(d.tables.loads!.fields).toContain("max_rate");
  });

  it("maps operations to tools and ops", async () => {
    const d = draftFromOpenApi(await freightSpec());
    const byName = Object.fromEntries(d.tools.map((t) => [t.name, t]));
    expect(Object.keys(byName)).toEqual(["get_carrier", "search_loads", "get_load", "create_booking", "create_escalation"]);
    expect(byName.get_load!.ops).toEqual([{ get: "loads", key: "$load_id" }]);
    expect(byName.search_loads!.ops[0]).toEqual({
      list: "loads",
      where: { origin: { $contains: "$origin" }, destination: { $contains: "$destination" }, equipment: "$equipment", status: "$status" },
    });
    expect(byName.search_loads!.params.status).toMatchObject({ required: false, default: "available", enum: ["available", "booked", "covered"] });
    expect(byName.create_booking!.ops).toEqual([{ create: "bookings", values: { load_id: "$load_id", mc_number: "$mc_number", rate: "$rate" } }]);
  });

  it("adds existence checks for foreign keys and review notes for what it cannot infer", async () => {
    const d = draftFromOpenApi(await freightSpec());
    const booking = d.tools.find((t) => t.name === "create_booking")!;
    expect(booking.checks.map((c) => c.table)).toEqual(["loads", "carriers"]);
    expect(booking.notes.join("\n")).toMatch(/409 \(Load is not available\)/);
    expect(booking.notes.join("\n")).toMatch(/side effect/);
  });

  it("writes a draft that validates", async () => {
    const d = draftFromOpenApi(await freightSpec());
    const dir = await mkdtemp(path.join(os.tmpdir(), "rehearse-init-"));
    await writeDraft(dir, { [DOMAIN_FILE]: renderDraft(d, "openapi.yaml"), "policy.md": POLICY_PLACEHOLDER, "tasks.yaml": TASKS_PLACEHOLDER });
    const domain = await loadDomain(dir);
    expect(domain.tools).toHaveLength(5);
    expect(domain.tasks).toEqual([]);
    expect(await readFile(path.join(dir, DOMAIN_FILE), "utf8")).toContain("# TODO(review): The API can answer 409");
    await expect(writeDraft(dir, { [DOMAIN_FILE]: "x" })).rejects.toThrow(/refusing to overwrite/);
  });
});

describe("init from OpenAPI: edge cases", () => {
  const spec = {
    openapi: "3.1.0",
    info: { title: "Shop API" },
    paths: {
      "/customers/{customer_id}/orders": {
        parameters: [{ name: "customer_id", in: "path", required: true, schema: { type: "string" } }],
        get: {
          operationId: "listCustomerOrders",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer" } },
            { name: "X-Trace", in: "header", schema: { type: "string" } },
          ],
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Order" },
                    example: [{ order_id: "O-1", customer_id: "C-1", total: 30 }],
                  },
                },
              },
            },
          },
        },
        post: {
          operationId: "createOrder",
          requestBody: {
            content: {
              "application/json": {
                schema: { type: "object", required: ["total"], properties: { total: { type: "number" }, items: { type: "array" } } },
              },
            },
          },
          responses: { "201": { description: "ok" } },
        },
      },
      "/orders/{order_id}": {
        delete: { responses: { "204": { description: "gone" } } },
        patch: {
          operationId: "updateOrder",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { note: { type: "string" } } } } } },
          responses: { "200": { description: "ok" } },
        },
      },
      "/orders/{order_id}/cancel": { post: { operationId: "cancelOrder", summary: "Cancel an order", responses: { "200": { description: "ok" } } } },
    },
    components: { schemas: { Order: { type: "object", properties: { order_id: { type: "string" }, customer_id: { type: "string" }, total: { type: "number" } } } } },
  };

  it("handles nested collections, actions, pagination, examples and unsupported bits", () => {
    const d = draftFromOpenApi(spec);
    expect(d.name).toBe("shop-api");
    expect(d.tables.orders).toMatchObject({ key: "order_id", rows: [{ order_id: "O-1", customer_id: "C-1", total: 30 }] });
    const byName = Object.fromEntries(d.tools.map((t) => [t.name, t]));
    expect(byName.list_customer_orders!.ops).toEqual([{ list: "orders", where: { customer_id: "$customer_id" } }]);
    expect(byName.list_customer_orders!.params).not.toHaveProperty("limit");
    expect(byName.create_order!.ops).toEqual([{ create: "orders", values: { customer_id: "$customer_id", total: "$total" } }]);
    expect(byName.update_order!.ops).toEqual([{ update: "orders", key: "$order_id", set: { note: "$note" } }]);
    expect(byName.cancel_order!.ops).toEqual([{ get: "orders", key: "$order_id" }]);
    expect(byName.cancel_order!.notes[0]).toMatch(/action on orders/);
    expect(d.warnings.join("\n")).toMatch(/header parameter "X-Trace" ignored/);
    expect(d.warnings.join("\n")).toMatch(/body field "items" is not a scalar/);
    expect(d.warnings.join("\n")).toMatch(/DELETE is not supported/);
  });

  it("names things consistently", () => {
    expect(snake("listCustomerOrders")).toBe("list_customer_orders");
    expect(snake("get-load by id")).toBe("get_load_by_id");
    expect(["carriers", "categories", "addresses", "status"].map(singularize)).toEqual(["carrier", "category", "address", "status"]);
  });
});
