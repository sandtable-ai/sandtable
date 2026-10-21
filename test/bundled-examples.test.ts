import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// The docs, the help and the plugin skills run `examples/freight`, which exists relative to the
// current directory only in a clone. Under `npx sandtable-ai`, the CLI uses the bundled copy.

const cli = path.resolve("src/cli.ts");
const run = (args: string[], cwd: string) =>
  promisify(execFile)(process.execPath, [cli, ...args], { cwd }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (e: { code: number; stdout: string; stderr: string }) => e,
  );

describe.skipIf(!process.features.typescript)("bundled examples", () => {
  const empty = mkdtempSync(path.join(tmpdir(), "sandtable-npx-"));

  it("examples/<name> falls back to the copy shipped with the package, and says so", async () => {
    for (const name of ["freight", "clinic"]) {
      const { code, stdout, stderr } = await run(["lint", `examples/${name}`], empty);
      expect(code).toBe(0);
      expect(stdout).toContain("0 error(s)");
      expect(stderr).toContain(`using the copy bundled with sandtable-ai, ${path.resolve("examples", name)}`);
    }
    const { code, stdout } = await run(["run", "./examples/freight/", "--agent", "noop", "--user", "scripted", "-t", "no-mc-number", "--no-html", "-o", path.join(empty, "out")], empty);
    expect(code).toBe(0);
    expect(stdout).toContain("pass^1 100.0%");
  });

  it("a local folder of that name wins, even one without a sandtable.yaml, and other missing paths still fail", async () => {
    const mine = mkdtempSync(path.join(tmpdir(), "sandtable-local-"));
    cpSync(path.resolve("examples/clinic"), path.join(mine, "examples", "freight"), { recursive: true });
    const local = await run(["validate", "examples/freight"], mine);
    expect(local.stdout).toContain("✓ clinic-front-desk:");
    expect(local.stderr).not.toContain("bundled");
    const broken = mkdtempSync(path.join(tmpdir(), "sandtable-local-"));
    mkdirSync(path.join(broken, "examples", "freight"), { recursive: true });
    const noSpec = await run(["validate", "examples/freight"], broken);
    expect(noSpec.code).toBe(2);
    expect(noSpec.stderr).toContain("no sandtable.yaml found at examples/freight");
    const missing = await run(["validate", "examples/nope"], empty);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("no sandtable.yaml found at examples/nope");
  });

  it("--help names no file outside the package, unless it says the file is in the repo", async () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { files: string[] };
    const shipped = (p: string) => pkg.files.some((f) => p === f || p.startsWith(`${f}/`)) || p.startsWith("dist/");
    for (const cmd of ["init", "validate", "lint", "review", "run", "leaderboard", "demo", "report"]) {
      const help = (await run([cmd, "--help"], empty)).stdout.replace(/\s+/g, " ");
      for (const m of help.matchAll(/\b[\w.-]+\/[\w./-]*\.(?:mjs|js|ts|json|ya?ml)\b/g)) {
        if (shipped(m[0]) || !existsSync(m[0])) continue;
        expect(help.slice(Math.max(0, m.index - 30), m.index), `${cmd} --help: ${m[0]}`).toMatch(/repo/);
      }
    }
  });
});
