import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { freightScriptedAgent } from "../src/demo/freight-agents.ts";
import { lintDomain } from "../src/grade/lint.ts";
import { runSuite } from "../src/run/suite.ts";
import { noopAgent } from "../src/sim/noop.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import type { AgentAdapter } from "../src/sim/types.ts";
import { loadDomain } from "../src/spec/load.ts";
import type { Domain } from "../src/spec/schema.ts";

let domain: Domain;
beforeAll(async () => {
  domain = await loadDomain(path.resolve("examples/freight"));
});

const hard = () => domain.tasks.filter((t) => t.tags.includes("hard"));

describe("freight rate design", () => {
  // never-disclose-ceiling scans every agent message for every load's max_rate. These two rules keep
  // a correct agent from tripping it by coincidence, by quoting a posted rate or a sensible counter.
  const loads = () => domain.world.tables.loads!.rows.map((r) => ({ id: String(r.load_id), posted: Number(r.posted_rate), max: Number(r.max_rate) }));

  it("no load's max_rate equals any load's posted_rate", () => {
    const posted = new Set(loads().map((l) => l.posted));
    expect(loads().filter((l) => posted.has(l.max)).map((l) => l.id)).toEqual([]);
  });

  it("no max_rate falls inside the range of a load that a task negotiates", () => {
    const byId = new Map(loads().map((l) => [l.id, l]));
    const negotiated = new Set<string>();
    for (const task of domain.tasks) {
      for (const call of task.reference ?? []) {
        const id = String(call.args.load_id);
        const rate = Number(call.args.rate);
        if (call.tool === "log_offer" || (/^(book_load|submit_offer)$/.test(call.tool) && rate > byId.get(id)!.posted)) negotiated.add(id);
      }
      // Negotiation tasks that expect no deal have no reference: take the loads their caller names.
      if (task.tags.includes("negotiation") && !task.reference) for (const m of task.user.instructions.matchAll(/L-\d{4}/g)) negotiated.add(m[0]);
    }
    expect(negotiated.size).toBeGreaterThan(8);
    const clashes = [...negotiated].flatMap((id) => {
      const l = byId.get(id)!;
      return loads().filter((o) => o.id !== id && o.max >= l.posted && o.max <= l.max).map((o) => `${o.id} max ${o.max} inside ${id} ${l.posted}-${l.max}`);
    });
    expect(clashes).toEqual([]);
  });
});

describe("freight hard tier", () => {
  it("has 18 tasks, each proven ready, solvable and non-vacuous by lint", () => {
    const report = lintDomain(domain);
    const lint = report.tasks.filter((t) => hard().some((h) => h.id === t.id));
    expect(lint).toHaveLength(18);
    for (const t of lint) expect(t, t.id).toMatchObject({ ready: true, solvable: true, noopPasses: false, errors: [], warnings: [] });
  });

  it("the careful agent passes every hard task and the naive and noop agents pass none", async () => {
    const taskIds = hard().map((t) => t.id);
    const run = (agent: AgentAdapter) => runSuite({ domain, agent, user: scriptedUser(), taskIds });
    const [careful, naive, noop] = await Promise.all([run(freightScriptedAgent("careful")), run(freightScriptedAgent("naive")), run(noopAgent())]);
    expect(careful.tasks.filter((t) => t.passes === 0).map((t) => t.id)).toEqual([]);
    expect(naive.tasks.filter((t) => t.passes > 0).map((t) => t.id)).toEqual([]);
    expect(noop.tasks.filter((t) => t.passes > 0).map((t) => t.id)).toEqual([]);
  });
});
