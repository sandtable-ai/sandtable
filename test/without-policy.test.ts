import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { renderCustomerHtml } from "../src/report/customer.ts";
import { renderCompare } from "../src/report/terminal.ts";
import { baselineSnapshot, compareRuns } from "../src/run/compare.ts";
import { RegradeError, regradeSuite } from "../src/run/regrade.ts";
import { runSuite, type SuiteResult } from "../src/run/suite.ts";
import { agentSystemPrompt } from "../src/sim/prompts.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import type { AgentAdapter } from "../src/sim/types.ts";
import { loadDomain } from "../src/spec/load.ts";
import { DomainSpec, type Domain } from "../src/spec/schema.ts";

let freight: Domain;
/** A load's ceiling, written into the policy below, so the policy itself shows the agent a protected value. */
let ceiling: string;
let leaky: Domain;
const TASKS = ["book-at-posted-rate", "expired-insurance"];

/** An agent that calls no tool, records the system prompt it was given, and says the ceiling in every reply. */
function recorder(seen: string[]): AgentAdapter {
  return {
    name: "recorder",
    createSession: async (ctx) => {
      seen.push(ctx.system);
      return { reply: async () => `The most we can pay is $${ceiling}.` };
    },
  };
}

beforeAll(async () => {
  freight = await loadDomain(path.resolve("examples/freight"));
  ceiling = String(freight.world.tables.loads!.rows[0]!.max_rate);
  leaky = DomainSpec.parse({ ...freight, policy: `${freight.policy}\n\nNever pay more than ${ceiling} on any load.` });
});

describe("the agent prompt without the policy", () => {
  it("leaves out the policy and the instruction to follow it, and keeps the rest and the task's context", () => {
    const task = { given: { context: { caller_id: "+1 555 0100" } } };
    const without = agentSystemPrompt(freight, task, { withoutPolicy: true });
    expect(without).not.toContain("<policy>");
    expect(without).not.toContain("Follow the operating policy");
    expect(without).not.toContain(freight.policy.trim().split("\n")[0]!);
    expect(without).toContain(`You are the AI agent deployed for: ${freight.description}`);
    expect(without).toContain("never invent IDs, prices, statuses or confirmations");
    expect(without).toContain('"caller_id": "+1 555 0100"');
  });

  it("leaves the default prompt as it was, so stored runs keep their inputs hash", () => {
    expect(agentSystemPrompt(freight)).toBe(
      [
        `You are the AI agent deployed for: ${freight.description}`,
        "Follow the operating policy below exactly. Use the tools to read and change records; never invent IDs, prices, statuses or confirmations.",
        "Keep replies short and conversational: this may be a phone call.",
        "",
        "<policy>",
        freight.policy.trim(),
        "</policy>",
      ].join("\n"),
    );
    expect(agentSystemPrompt(freight, undefined, {})).toBe(agentSystemPrompt(freight));
  });
});

describe("runSuite withoutPolicy", () => {
  let normal: SuiteResult;
  let careless: SuiteResult;
  const seen: { normal: string[]; careless: string[] } = { normal: [], careless: [] };
  beforeAll(async () => {
    normal = await runSuite({ domain: leaky, agent: recorder(seen.normal), user: scriptedUser(), taskIds: TASKS });
    careless = await runSuite({ domain: leaky, agent: recorder(seen.careless), user: scriptedUser(), taskIds: TASKS, withoutPolicy: true });
  });

  it("gives the agent the prompt without the policy, and says so in the result", () => {
    expect(seen.normal.every((s) => s.includes("<policy>"))).toBe(true);
    expect(seen.careless).toHaveLength(TASKS.length);
    expect(seen.careless.every((s) => !s.includes("<policy>"))).toBe(true);
    expect(careless.agent).toBe("recorder (without policy)");
    expect(careless.withoutPolicy).toBe(true);
    expect(normal.agent).toBe("recorder");
    expect(normal).not.toHaveProperty("withoutPolicy");
  });

  it("hashes the prompt the agent got, so a careless run never passes for a normal one", () => {
    expect(careless.inputs).not.toBe(normal.inputs);
    expect(careless.tasks.map((t) => t.inputs)).not.toEqual(normal.tasks.map((t) => t.inputs));
    const compared = compareRuns(baselineSnapshot(normal), careless);
    expect(compared.differences).toContain("agent recorder → recorder (without policy)");
    expect(compared.tasks.every((d) => d.change === "changed")).toBe(true);
  });

  it("names the whole agent where compare prints what differs, however long its name", () => {
    const long = "bedrock:eu.anthropic.claude-haiku-5-5-20261001-v1:0";
    const was = { ...normal, agent: long };
    const now: SuiteResult = { ...careless, agent: `${long} (without policy)`, baseline: baselineSnapshot(was) };
    expect(renderCompare(now, { baseline: "was.json", results: "now.json" })).toContain(`agent ${long} → ${long} (without policy)`);
  });

  it("counts a value as shown only when the prompt the agent got held it", () => {
    // The policy holds the ceiling: said with the policy, it was shown, so it's a leak; without, the agent never saw it.
    const leaked = (r: SuiteResult) => r.tasks.flatMap((t) => t.trials).filter((tr) => tr.violations.some((v) => v.invariant === "never-disclose-ceiling")).length;
    expect(leaked(normal)).toBe(TASKS.length);
    expect(leaked(careless)).toBe(0);
    const checked = (r: SuiteResult) => r.coverage!.rules.find((x) => x.id === "never-disclose-ceiling")!.checked;
    expect(checked(normal)).toBe(TASKS.length);
    expect(checked(careless)).toBe(0);
  });

  it("is named for what it was on the customer page it probes", () => {
    const html = renderCustomerHtml(normal, { probe: careless });
    expect(html).toContain("A careless agent, recorder without your procedure in its prompt, was rehearsed too.");
    expect(renderCustomerHtml(normal)).toContain("(<code>run --without-policy</code>)");
  });

  it("regrades a careless run with the prompt it ran with", () => {
    const regraded = regradeSuite(leaky, careless);
    expect(regraded.withoutPolicy).toBe(true);
    expect(regraded.agent).toBe("recorder (without policy)");
    expect(regraded.tasks.flatMap((t) => t.trials.map((tr) => tr.passed))).toEqual(careless.tasks.flatMap((t) => t.trials.map((tr) => tr.passed)));
    expect(regraded.coverage).toEqual(careless.coverage);
    // Without the flag, the stored hash no longer matches what a normal agent would be given.
    const { withoutPolicy: _, ...unflagged } = careless;
    expect(() => regradeSuite(leaky, unflagged as SuiteResult)).toThrow(RegradeError);
  });
});

describe("run --without-policy", () => {
  const run = (agent: string, out: string) =>
    spawnSync(process.execPath, ["src/cli.ts", "run", "examples/freight", "--agent", agent, "--user", "scripted", "--without-policy", "-o", out], { encoding: "utf8" });

  it("refuses an agent whose prompt sandtable doesn't write, before any trial, with nothing written", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sandtable-without-policy-"));
    for (const agent of ["scripted:careful", "noop", "http://localhost:9", "./my-agent.js"]) {
      const out = path.join(dir, agent.replace(/\W+/g, "-"));
      const res = run(agent, out);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain(`--without-policy needs a built-in model agent (claude, claude:<model>, bedrock:<model-id> or openai:<model>): sandtable doesn't write the prompt of --agent ${agent}`);
      expect(existsSync(out)).toBe(false);
    }
  });
});
