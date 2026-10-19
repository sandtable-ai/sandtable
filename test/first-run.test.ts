import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { httpAgent } from "../src/sim/http.ts";

// What a new user sees on the first run: the demo's next steps must run as printed, however
// sandtable was started (npx, uvx through the PyPI launcher, or an installed `sandtable`).

const cli = path.resolve("src/cli.ts");
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("npm_") && k !== "SANDTABLE_INVOKED_AS"));

async function demoNext(env: Record<string, string>): Promise<string[]> {
  const cwd = mkdtempSync(path.join(tmpdir(), "sandtable-demo-"));
  const { stdout } = await promisify(execFile)(process.execPath, [cli, "demo", "--no-open"], { cwd, env: { ...cleanEnv, ...env } });
  return stdout.slice(stdout.lastIndexOf("Next:")).trimEnd().split("\n");
}

describe.skipIf(!process.features.typescript)("the demo's next steps", () => {
  it("use the command the user ran, with the cheap caller model, and fit 80 columns", async () => {
    for (const [env, me] of [
      [{ npm_lifecycle_event: "npx", npm_command: "exec" }, "npx sandtable-ai"],
      [{ SANDTABLE_INVOKED_AS: "uvx sandtable-ai", npm_lifecycle_event: "npx" }, "uvx sandtable-ai"],
      [{ npm_lifecycle_event: "demo", npm_command: "run-script" }, "npm run sandtable --"],
      [{}, "sandtable"],
    ] as const) {
      const lines = await demoNext(env);
      expect(lines).toContain(`    ${me} demo --live --user-model claude-haiku-5-5`);
      expect(lines).toContain(`    ${me} init --openapi api.yaml --sop sop.md -o mine`);
      for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(80);
    }
  });
});

describe("first-run names and help", () => {
  it("names an HTTP agent by its URL", () => {
    expect(httpAgent("http://localhost:8787/step").name).toBe("http://localhost:8787/step");
  });

  it.skipIf(!process.features.typescript)("run --help lists the demo agents under --agent", async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [cli, "run", "--help"]);
    const help = stdout.replace(/\s+/g, " ");
    for (const spec of ["scripted:naive", "scripted:careful", "scripted:clinic-naive", "scripted:clinic-careful"]) expect(help).toContain(spec);
  });
});
