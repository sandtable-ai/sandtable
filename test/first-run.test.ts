import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { httpAgent } from "../src/sim/http.ts";

// What a new user sees on the first run: the next steps must run as printed for every install
// (npm, npx, or the PyPI launcher, which needs npx too), so they use `npx sandtable-ai`.

const cli = path.resolve("src/cli.ts");
const nextSteps = (stdout: string) => stdout.slice(stdout.lastIndexOf("Next:")).trimEnd().split("\n");

describe.skipIf(!process.features.typescript)("the next steps", () => {
  it("after demo: npx commands, with the cheap caller model, within 80 columns", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "sandtable-demo-"));
    const lines = nextSteps((await promisify(execFile)(process.execPath, [cli, "demo", "--no-open"], { cwd })).stdout);
    expect(lines).toContain("    npx sandtable-ai demo --live --user-model claude-haiku-5-5");
    expect(lines).toContain("    npx sandtable-ai init --openapi api.yaml --sop sop.md -o mine");
    for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(80);
  });

  it("after init: npx commands to review and validate the draft", async () => {
    const out = path.join(mkdtempSync(path.join(tmpdir(), "sandtable-init-")), "mine");
    const { stdout } = await promisify(execFile)(process.execPath, [cli, "init", "--openapi", path.resolve("examples/freight/source/openapi.yaml"), "-o", out]);
    expect(nextSteps(stdout).slice(1)).toEqual([`  npx sandtable-ai review ${out}`, `  npx sandtable-ai validate ${out} --strict`]);
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
