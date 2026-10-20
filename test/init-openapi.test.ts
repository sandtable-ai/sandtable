import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { promisify } from "node:util";
import { draftFromOpenApi, openApiProblem, singularize, snake } from "../src/init/openapi.ts";
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
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-init-"));
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

describe("init from OpenAPI: allOf-composed schemas", () => {
  // A fictional repair shop whose bodies and responses extend a shared base entity with allOf.
  const ticketBody = (required: string[]) => ({
    allOf: [
      { $ref: "#/components/schemas/Entity" },
      { type: "object", required, properties: { device_serial: { type: "string" }, issue: { type: "string" }, priority: { $ref: "#/components/schemas/Priority" }, parts: { type: "array" } } },
    ],
  });
  const spec = {
    openapi: "3.0.3",
    info: { title: "Quillmoor Repairs" },
    paths: {
      "/repair_tickets": {
        get: {
          operationId: "listRepairTickets",
          parameters: [{ name: "priority", in: "query", description: "Only tickets this urgent", schema: { allOf: [{ $ref: "#/components/schemas/Priority" }], default: "normal" } }],
          responses: { "200": { content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/RepairTicket" } } } } } },
        },
        post: {
          operationId: "createRepairTicket",
          requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/RepairTicket_Create" } } } },
          responses: { "201": { description: "created" } },
        },
      },
      "/repair_tickets/{ticket_id}": {
        patch: {
          operationId: "updateRepairTicket",
          parameters: [{ name: "ticket_id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { content: { "application/json": { schema: ticketBody([]) } } },
          responses: { "200": { description: "ok" } },
        },
      },
    },
    components: {
      schemas: {
        Base: { type: "object", required: ["kind"], properties: { kind: { type: "string" } } },
        // Nested: a member that is itself composed.
        Entity: { allOf: [{ $ref: "#/components/schemas/Base" }, { type: "object", properties: { ticket_id: { type: "string" }, opened_at: { type: "string" } } }] },
        Priority: { type: "string", enum: ["low", "normal", "urgent"], description: "How urgent the repair is" },
        RepairTicket: { allOf: [{ $ref: "#/components/schemas/Entity" }, { type: "object", properties: { device_serial: { type: "string" }, status: { type: "string" } } }] },
        RepairTicket_Create: ticketBody(["device_serial", "issue"]),
      },
    },
  };

  it("merges the members' properties into tool params and create values", () => {
    const byName = Object.fromEntries(draftFromOpenApi(spec).tools.map((t) => [t.name, t]));
    const create = byName.create_repair_ticket!;
    expect(create.ops).toEqual([
      { create: "repair_tickets", values: { kind: "$kind", ticket_id: "$ticket_id", opened_at: "$opened_at", device_serial: "$device_serial", issue: "$issue", priority: "$priority" } },
    ]);
    expect(create.params.device_serial).toMatchObject({ type: "string", required: true });
    expect(create.params.kind).toMatchObject({ required: true });
    expect(create.params.opened_at).toMatchObject({ required: false });
    expect(create.params.priority).toMatchObject({ enum: ["low", "normal", "urgent"], description: "How urgent the repair is" });
    expect(byName.update_repair_ticket!.ops[0]).toMatchObject({ update: "repair_tickets", key: "$ticket_id", set: { device_serial: "$device_serial", issue: "$issue" } });
  });

  it("reads table fields from every member and composed params whole", () => {
    const d = draftFromOpenApi(spec);
    expect(d.tables.repair_tickets).toMatchObject({ key: "ticket_id" });
    expect(d.tables.repair_tickets!.fields).toEqual(expect.arrayContaining(["kind", "ticket_id", "opened_at", "device_serial", "status", "issue"]));
    // The param's own keywords win over its members'.
    expect(d.tools.find((t) => t.name === "list_repair_tickets")!.params.priority).toEqual({
      type: "string",
      required: false,
      description: "Only tickets this urgent",
      enum: ["low", "normal", "urgent"],
      default: "normal",
    });
    expect(d.warnings.join("\n")).toMatch(/body field "parts" is not a scalar/);
  });
});

describe("init from OpenAPI: names that aren't identifiers", () => {
  // A fictional courier whose fields follow a JSON-LD style (`@type`) and kebab-case.
  const str = { type: "string" };
  const spec = {
    openapi: "3.0.3",
    info: { title: "Brindle Couriers" },
    paths: {
      "/couriers/{courier-id}": { get: { parameters: [{ name: "courier-id", in: "path", required: true, schema: str }], responses: { "200": { description: "ok" } } } },
      "/couriers/{courier-id}/jobs": {
        parameters: [{ name: "courier-id", in: "path", required: true, schema: str }],
        get: { operationId: "listJobs", parameters: [{ name: "created-after", in: "query", schema: str }], responses: { "200": { description: "ok" } } },
        post: {
          operationId: "createJob",
          requestBody: {
            content: {
              "application/json": {
                schema: { allOf: [{ type: "object", required: ["@type"], properties: { "@type": str, "@baseType": str } }, { type: "object", properties: { "pickup-window": str, note: str } }] },
              },
            },
          },
          responses: { "201": { description: "created" } },
        },
      },
      // The path parameter is not declared, as hand-written specs sometimes leave it.
      "/jobs/{job_id}": { patch: { operationId: "updateJob", requestBody: { content: { "application/json": { schema: { type: "object", properties: { "@type": str } } } } }, responses: { "200": { description: "ok" } } } },
    },
  };

  it("gives such fields params with identifier names and maps them back in the ops", () => {
    const byName = Object.fromEntries(draftFromOpenApi(spec).tools.map((t) => [t.name, t]));
    const create = byName.create_job!;
    expect(Object.keys(create.params)).toEqual(["courier_id", "at_type", "at_baseType", "pickup_window", "note"]);
    expect(create.params.at_type).toMatchObject({ type: "string", required: true });
    expect(create.ops).toEqual([
      { create: "jobs", values: { "courier-id": "$courier_id", "@type": "$at_type", "@baseType": "$at_baseType", "pickup-window": "$pickup_window", note: "$note" } },
    ]);
    expect(create.checks).toEqual([{ table: "couriers", key: "$courier_id", error: "couriers ${courier_id} not found" }]);
    expect(byName.list_jobs!.ops).toEqual([{ list: "jobs", where: { "courier-id": "$courier_id", "created-after": { $contains: "$created_after" } } }]);
    expect(byName.update_job!.params).toEqual({ job_id: { type: "string", required: true }, at_type: { type: "string", required: false } });
    expect(byName.update_job!.ops).toEqual([{ update: "jobs", key: "$job_id", set: { "@type": "$at_type" } }]);
  });

  it("keeps names that already work, and warns when a rewritten name takes a suffix", () => {
    const properties = Object.fromEntries(["@type", "at_type", "a-b", "a_b", "a.b", "constructor", "toString"].map((f) => [f, str]));
    const body = { content: { "application/json": { schema: { type: "object", properties } } } };
    const d = draftFromOpenApi({ ...spec, paths: { "/parcels": { post: { operationId: "createParcel", requestBody: body, responses: { "201": { description: "ok" } } } } } });
    const create = d.tools[0]!;
    expect(create.ops).toEqual([
      { create: "parcels", values: { "@type": "$at_type_2", at_type: "$at_type", "a-b": "$a_b_2", a_b: "$a_b", "a.b": "$a_b_3", constructor: "$constructor", toString: "$toString" } },
    ]);
    expect(Object.keys(create.params)).toEqual(["at_type_2", "at_type", "a_b_2", "a_b", "a_b_3", "constructor", "toString"]);
    expect(d.warnings).toEqual([
      'POST /parcels: "@type" is param "at_type_2", since "at_type" is another field\'s param',
      'POST /parcels: "a-b" is param "a_b_2", since "a_b" is another field\'s param',
      'POST /parcels: "a.b" is param "a_b_3", since "a_b" is another field\'s param',
    ]);
  });

  it("writes a draft that validates", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-init-"));
    await writeDraft(dir, { [DOMAIN_FILE]: renderDraft(draftFromOpenApi(spec), "openapi.yaml"), "policy.md": POLICY_PLACEHOLDER, "tasks.yaml": TASKS_PLACEHOLDER });
    expect((await loadDomain(dir)).tools.map((t) => t.name)).toEqual(["get_couriers", "list_jobs", "create_job", "update_job"]);
  });
});

describe("init from OpenAPI: webhook listeners and subscriptions", () => {
  // A fictional parcel carrier whose spec also documents the webhooks its clients implement.
  const post = (extra: Record<string, unknown> = {}) => ({ ...extra, responses: { "204": { description: "received" } } });
  const listed = (properties: Record<string, unknown>) => ({
    get: { responses: { "200": { content: { "application/json": { schema: { type: "array", items: { type: "object", properties } } } } } } },
  });
  const spec = {
    openapi: "3.1.0",
    info: { title: "Ternwick Parcels" },
    paths: {
      "/parcels": {
        ...listed({ parcel_id: { type: "string" } }),
        post: {
          operationId: "createParcel",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { recipient: { type: "string" }, delivered_hook: { type: "string" } } } } } },
          callbacks: {
            parcelDelivered: { "{$request.body#/delivered_hook}": { post: post() } },
            parcelLost: { $ref: "#/components/callbacks/ParcelLost" },
          },
          responses: { "201": { description: "created" } },
        },
      },
      "/listener/parcelDelayedEvent": { post: post({ tags: ["Notification listener"] }) },
      "/listener/parcelReturnedEvent": { post: post() },
      "/hub": { post: post({ requestBody: { content: { "application/json": { schema: { type: "object", properties: { callback: { type: "string" }, query: { type: "string" } } } } } } }) },
      "/hub/{id}": { get: post(), delete: post() },
      "/event_subscriptions": { post: post({ tags: ["Events subscription"], requestBody: { content: { "application/json": { schema: { type: "object", properties: { url: { type: "string" } } } } } } }) },
      // Real resources that only sound similar: all drafted.
      "/hubs": listed({ hub_id: { type: "string" }, city: { type: "string" } }),
      "/hubs/{hub_id}": { get: post() },
      "/depots/{depot_id}/listeners": listed({ listener_id: { type: "string" } }),
      "/subscriptions": { ...listed({ subscription_id: { type: "string" } }), post: post({ tags: ["Subscriptions"], requestBody: { content: { "application/json": { schema: { type: "object", properties: { plan: { type: "string" } } } } } } }) },
    },
    webhooks: { parcelOutForDelivery: { post: post() } },
    components: { callbacks: { ParcelLost: { "https://client.example/lost": { post: post() } } } },
  };

  it("skips them with a warning that names each one", () => {
    const d = draftFromOpenApi(spec);
    expect(Object.keys(d.tables)).toEqual(["hubs", "listeners", "parcels", "subscriptions"]);
    expect(d.tools.map((t) => t.name)).toEqual(["get_parcels", "create_parcel", "get_hubs", "get_hubs_2", "get_listeners", "get_subscriptions", "post_subscriptions"]);
    const skipped = d.warnings.filter((w) => w.endsWith("; skipped"));
    expect(skipped).toEqual([
      'POST /parcels: callback "parcelDelivered" ({$request.body#/delivered_hook}), a request the API sends to the client; skipped',
      'POST /parcels: callback "parcelLost" (https://client.example/lost), a request the API sends to the client; skipped',
      '/listener/parcelDelayedEvent: a webhook listener or event subscription (tagged "Notification listener"), not a resource; skipped',
      "/listener/parcelReturnedEvent: a webhook listener or event subscription (only POST, under /listener), not a resource; skipped",
      "/hub: a webhook listener or event subscription (POST /hub takes a callback), not a resource; skipped",
      "/hub/{id}: a webhook listener or event subscription (POST /hub takes a callback), not a resource; skipped",
      '/event_subscriptions: a webhook listener or event subscription (tagged "Events subscription"), not a resource; skipped',
      "webhooks.parcelOutForDelivery: an OpenAPI webhook, a request the API sends to the client; skipped",
    ]);
  });
});

describe("init from OpenAPI: what it refuses", () => {
  it("accepts an OpenAPI 3.x document with paths", async () => {
    expect(openApiProblem(await freightSpec())).toBeUndefined();
    // `openapi: 3.0` without quotes parses as a number.
    expect(openApiProblem({ openapi: 3, paths: { "/a": {} } })).toBeUndefined();
    expect(openApiProblem({ openapi: 3.1, paths: { "/a": {} } })).toBeUndefined();
  });

  it("names Swagger 2.0, other documents and empty specs", () => {
    expect(openApiProblem({ swagger: "2.0", info: { title: "t" }, paths: { "/a": {} } })).toMatch(/^is Swagger 2\.0; init reads OpenAPI 3\.x\. Convert it/);
    expect(openApiProblem({ hello: "world" })).toMatch(/^is not an OpenAPI 3\.x document/);
    expect(openApiProblem({ openapi: "4.0.0", paths: { "/a": {} } })).toBe("is OpenAPI 4.0.0; init reads OpenAPI 3.x");
    expect(openApiProblem({ openapi: "3.1.0", paths: {} })).toMatch(/^has no paths/);
    expect(openApiProblem(["not", "a", "mapping"])).toMatch(/^is not an OpenAPI document/);
  });

  it.skipIf(!process.features.typescript)("writes nothing for a Swagger 2.0 spec and exits 1", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-init-"));
    const spec = path.join(dir, "swagger.yaml");
    await writeFile(spec, 'swagger: "2.0"\ninfo: { title: legacy, version: "1" }\npaths: {}\n');
    const out = path.join(dir, "domain");
    const err = await promisify(execFile)(process.execPath, [path.resolve("src/cli.ts"), "init", "--openapi", spec, "-o", out]).then(
      () => undefined,
      (e: { code: number; stderr: string }) => e,
    );
    expect(err?.code).toBe(1);
    expect(err?.stderr).toContain("is Swagger 2.0; init reads OpenAPI 3.x");
    await expect(readdir(out)).rejects.toThrow(/ENOENT/);
  });
});
