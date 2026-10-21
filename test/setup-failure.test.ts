import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { everyTrialFailed, runSuite } from "../src/run/suite.ts";
import { noopAgent } from "../src/sim/noop.ts";
import { scriptedUser } from "../src/sim/scripted.ts";
import type { AgentAdapter } from "../src/sim/types.ts";
import { loadDomain } from "../src/spec/load.ts";

// Missing credentials, a missing optional package or an unreachable agent make every trial end in
// an error. Such a run graded nothing about the agent, so it must not pass as a 0% score with exit 0.

const example = path.resolve("examples/freight");
const tasks = ["book-at-posted-rate", "no-mc-number"];
const broken: AgentAdapter = {
  name: "broken",
  async createSession() {
    throw new Error("no credentials");
  },
};

describe("a run where every trial ended in an error", () => {
  it("is reported with the first error", async () => {
    const r = await runSuite({ domain: await loadDomain(example), agent: broken, user: scriptedUser(), taskIds: tasks });
    expect(everyTrialFailed(r)).toBe("no credentials");
  });

  it("is not reported when any trial got past setup", async () => {
    const r = await runSuite({ domain: await loadDomain(example), agent: noopAgent(), user: scriptedUser(), taskIds: tasks });
    expect(everyTrialFailed(r)).toBeUndefined();
  });

  it.skipIf(!process.features.typescript)("makes `run` exit 2 and print the error, even without --fail-under", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sandtable-setup-"));
    const agent = path.join(dir, "agent.mjs");
    writeFileSync(agent, 'export default { name: "broken", async createSession() { throw new Error("no credentials"); } };\n');
    const args = [path.resolve("src/cli.ts"), "run", example, "--agent", agent, "--user", "scripted", "-t", tasks.join(","), "--no-html", "-o", path.join(dir, "out")];
    const err = await promisify(execFile)(process.execPath, args).then(
      () => undefined,
      (e: { code: number; stderr: string }) => e,
    );
    expect(err?.code).toBe(2);
    expect(err?.stderr).toContain("Every trial ended in an error");
    expect(err?.stderr).toContain("no credentials");
  });
});
