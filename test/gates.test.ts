import path from "node:path";
import { describe, expect, it } from "vitest";
import { freightScriptedAgent } from "../src/demo/freight-agents.ts";
import { runGates } from "../src/run/gates.ts";
import { runSuite } from "../src/run/suite.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import type { AgentAdapter } from "../src/sim/types.ts";
import { loadDomain } from "../src/spec/load.ts";

// `run` and `demo --live` apply the same gates to a finished run: skipped trials exit 2, a critical task with a
// failed trial exits 1, and so does pass^k below --fail-under.

const example = path.resolve("examples/freight");
const run = async (agent: AgentAdapter, taskIds: string[]) => runSuite({ domain: await loadDomain(example), agent, user: scriptedUser(), k: 1, taskIds });

describe("runGates", () => {
  it("passes a complete run with no critical failure and no threshold", async () => {
    expect(runGates(await run(freightScriptedAgent("careful"), ["expired-insurance", "book-at-posted-rate"]))).toEqual([]);
  });

  it("fails a critical task with any failed trial, with exit 1", async () => {
    const gates = runGates(await run(freightScriptedAgent("naive"), ["expired-insurance", "book-at-posted-rate"]));
    expect(gates).toEqual([{ status: 1, message: "1 critical task(s) did not pass every trial: expired-insurance 0/1" }]);
  });

  it("fails pass^k below --fail-under, with exit 1", async () => {
    const result = await run(freightScriptedAgent("careful"), ["book-at-posted-rate"]);
    expect(runGates(result, { failUnder: 1 })).toEqual([]);
    result.passHat["1"] = 0.5;
    expect(runGates(result, { failUnder: 0.6 })).toEqual([{ status: 1, message: "pass^1 50.0% is below --fail-under 60.0%" }]);
  });

  it("fails a run with skipped trials, with exit 2, before the other gates", async () => {
    const crash: AgentAdapter = { name: "crash", createSession: async () => ({ reply: async () => { throw new Error("no credentials"); } }) };
    const gates = runGates(await run(crash, ["book-at-posted-rate", "expired-insurance"]), { failUnder: 1 });
    expect(gates.map((g) => g.status)).toEqual([2, 1]);
    expect(gates[0]!.message).toBe("2 of 2 trial(s) ended in an error before the agent broke any rule, so they were skipped and this run is incomplete: rerun it. The first error:\n  no credentials");
  });
});
