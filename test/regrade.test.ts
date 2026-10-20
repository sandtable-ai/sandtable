import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { freightScriptedAgent } from "../src/demo/freight-agents.ts";
import { regradeSuite, RegradeError } from "../src/run/regrade.ts";
import { runSuite, type SuiteResult } from "../src/run/suite.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import { loadDomain } from "../src/spec/load.ts";
import type { Domain } from "../src/spec/schema.ts";

const example = path.resolve("examples/freight");
const cli = path.resolve("src/cli.ts");

/** A run as it comes back from disk. */
async function stored(domain: Domain, mode: "careful" | "naive"): Promise<SuiteResult> {
  const result = await runSuite({ domain, agent: freightScriptedAgent(mode), user: scriptedUser() });
  return JSON.parse(JSON.stringify(result)) as SuiteResult;
}

const verdicts = (r: SuiteResult) => Object.fromEntries(r.tasks.flatMap((t) => t.trials.map((tr) => [`${tr.taskId}#${tr.trial}`, tr.passed])));

describe("regrade", () => {
  it("reproduces a run's verdicts, checks and scores exactly when nothing changed", async () => {
    const domain = await loadDomain(example);
    for (const mode of ["careful", "naive"] as const) {
      const run = await stored(domain, mode);
      expect(regradeSuite(domain, run)).toEqual(run);
    }
  });

  it("applies an edited invariant to the stored trials without calling a model", async () => {
    const domain = await loadDomain(example);
    const run = await stored(domain, "careful");
    const edited: Domain = {
      ...domain,
      invariants: [...domain.invariants, { id: "no-reefer-bookings", description: "Never book a reefer load.", never: { tool: "book_load", when: { load_id: "L-1005" } } }],
    };
    const regraded = regradeSuite(edited, run);
    const affected = run.tasks.filter((t) => t.trials[0]!.events.some((e) => e.type === "tool" && e.name === "book_load" && (e.args as { load_id?: string }).load_id === "L-1005")).map((t) => t.id);
    expect(affected).toContain("equipment-mismatch");

    const trial = regraded.tasks.find((t) => t.id === "equipment-mismatch")!.trials[0]!;
    expect(trial.passed).toBe(false);
    expect(trial.violations.map((v) => v.invariant)).toEqual(["no-reefer-bookings"]);
    expect(trial.events.find((e) => e.type === "tool" && e.name === "book_load")).toMatchObject({ violations: ["no-reefer-bookings"] });
    expect(regraded.failureModes[0]).toMatchObject({ id: "no-reefer-bookings", count: affected.length, tasks: affected });
    expect(regraded.passHat["1"]).toBeCloseTo(run.passHat["1"]! - affected.length / run.tasks.length);
    // Only the edited rule's verdicts moved; the conversation is the one recorded.
    const changed = Object.entries(verdicts(regraded)).filter(([id, passed]) => verdicts(run)[id] !== passed);
    expect(changed).toEqual(affected.map((id) => [`${id}#0`, false]));
    expect(trial.events.filter((e) => e.type !== "tool")).toEqual(run.tasks.find((t) => t.id === "equipment-mismatch")!.trials[0]!.events.filter((e) => e.type !== "tool"));
  });

  it("applies edited expectations, and drops a removed invariant's failures", async () => {
    const domain = await loadDomain(example);
    const run = await stored(domain, "naive");
    const failedOn = (r: SuiteResult, id: string) => r.tasks.flatMap((t) => t.trials).filter((tr) => tr.checks.some((c) => c.id === id && !c.passed)).length;
    expect(failedOn(run, "verify-before-book")).toBeGreaterThan(0);

    const withoutRule: Domain = { ...domain, invariants: domain.invariants.filter((i) => i.id !== "verify-before-book") };
    expect(failedOn(regradeSuite(withoutRule, run), "verify-before-book")).toBe(0);

    const stricter: Domain = {
      ...domain,
      tasks: domain.tasks.map((t) => (t.id === "book-at-posted-rate" ? { ...t, expect: { ...t.expect, reply_includes: ["have a great haul"] } } : t)),
    };
    const trial = regradeSuite(stricter, run).tasks.find((t) => t.id === "book-at-posted-rate")!.trials[0]!;
    expect(trial.checks.find((c) => c.kind === "reply")).toMatchObject({ passed: false, detail: 'agent never said "have a great haul"' });
  });

  it("refuses when the agent or the caller would see something else now", async () => {
    const domain = await loadDomain(example);
    const run = await stored(domain, "careful");
    const cases: [string, Domain][] = [
      ["policy", { ...domain, policy: `${domain.policy}\n- Always upsell.` }],
      ["seed records", { ...domain, world: { tables: { ...domain.world.tables, loads: { ...domain.world.tables.loads!, rows: domain.world.tables.loads!.rows.slice(1) } } } }],
      ["tool description", { ...domain, tools: domain.tools.map((t) => (t.name === "get_load" ? { ...t, description: "Look up a load." } : t)) }],
      ["caller instructions", { ...domain, tasks: domain.tasks.map((t, i) => (i === 0 ? { ...t, user: { ...t.user, instructions: "Ask for a discount." } } : t)) }],
    ];
    for (const [what, edited] of cases) {
      expect(() => regradeSuite(edited, run), what).toThrow(/would see something else now/);
    }
    // A task added since the run is not part of it, so it doesn't block the regrade.
    const added: Domain = { ...domain, tasks: [...domain.tasks, { ...domain.tasks[0]!, id: "new-task" }] };
    expect(regradeSuite(added, run).tasks).toHaveLength(run.tasks.length);
  });

  it("refuses a tool call whose result is no longer what the agent saw", async () => {
    const domain = await loadDomain(example);
    const run = await stored(domain, "careful");
    const trial = run.tasks.find((t) => t.id === "book-at-posted-rate")!.trials[0]!;
    const call = trial.events.find((e) => e.type === "tool" && e.name === "verify_carrier")!;
    if (call.type === "tool") call.result = { mc_number: "100101", name: "Someone Else" };
    expect(() => regradeSuite(domain, run)).toThrow(new RegradeError("book-at-posted-rate trial 1: tool call 1 (verify_carrier) returns something else now than what the agent saw"));
  });

  it("refuses results of another domain, with a task that is gone, or with no inputs fingerprint", async () => {
    const domain = await loadDomain(example);
    const run = await stored(domain, "careful");
    expect(() => regradeSuite(domain, { ...run, domain: "clinic-front-desk" })).toThrow(/it is a run of clinic-front-desk, not freight-carrier-sales/);
    expect(() => regradeSuite({ ...domain, tasks: domain.tasks.slice(1) }, run)).toThrow(/task book-at-posted-rate is no longer in the domain/);
    const { inputs: _, ...older } = run;
    expect(() => regradeSuite(domain, older)).toThrow(/records no inputs fingerprint/);
  });

  it.skipIf(!process.features.typescript)("sandtable regrade rewrites results.json under an edited domain and lists the verdicts that changed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-regrade-"));
    const domainDir = path.join(dir, "freight");
    await cp(example, domainDir, { recursive: true });
    const run = await stored(await loadDomain(domainDir), "careful");
    await writeFile(path.join(dir, "results.json"), JSON.stringify(run));

    // Cap every booking at 2,200: the careful agent's bookings above it now break rate-ceiling.
    const spec = path.join(domainDir, "sandtable.yaml");
    const yaml = await readFile(spec, "utf8");
    await writeFile(spec, yaml.replace("    lte: { table: loads, key_arg: load_id, field: max_rate }\n", "    lte: 2200\n"));
    const above = run.tasks.filter((t) => t.trials[0]!.events.some((e) => e.type === "tool" && e.name === "book_load" && Number((e.args as { rate?: number }).rate) > 2200)).map((t) => t.id);
    expect(above).toContain("negotiate-within-ceiling");

    const { stdout } = await promisify(execFile)(process.execPath, [cli, "regrade", path.join(dir, "results.json"), "--domain", domainDir, "--no-html"]);
    expect(stdout).toContain(`regraded 50 trial(s) without calling a model: ${above.length} verdict(s) changed`);
    for (const id of above) expect(stdout).toContain(`✓ → ✗  ${id} trial 1`);
    expect(stdout).toContain(`pass^1 100.0% → ${((1 - above.length / 50) * 100).toFixed(1)}%`);
    const regraded = JSON.parse(await readFile(path.join(dir, "results.json"), "utf8")) as SuiteResult;
    expect(regraded.failureModes[0]).toMatchObject({ id: "rate-ceiling", tasks: above });
    expect(regraded.runId).toBe(run.runId);
  });

  it.skipIf(!process.features.typescript)("sandtable regrade says why it can't, and writes nothing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-regrade-"));
    const domainDir = path.join(dir, "freight");
    await cp(example, domainDir, { recursive: true });
    const run = await stored(await loadDomain(domainDir), "careful");
    const file = path.join(dir, "results.json");
    await writeFile(file, JSON.stringify(run));
    const policy = path.join(domainDir, "policy.md");
    await writeFile(policy, `${await readFile(policy, "utf8")}\n- Always upsell.\n`);

    const err = await promisify(execFile)(process.execPath, [cli, "regrade", file, "--domain", domainDir]).catch((e: { code: number; stderr: string }) => e);
    expect(err).toMatchObject({ code: 1 });
    expect((err as { stderr: string }).stderr).toMatch(/^can't regrade .*results\.json: the agent or the caller would see something else now: .*Rerun it with `sandtable run` instead\./);
    expect(await readFile(file, "utf8")).toBe(JSON.stringify(run));
  });
});
