import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// AGENTS.md (which CLAUDE.md imports) tells coding agents which commands to run and which files
// own what. These tests keep it true as the repository changes.

const root = process.cwd();
const text = readFileSync(path.join(root, "AGENTS.md"), "utf8");
const scripts = Object.keys((JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: object }).scripts);

describe("AGENTS.md", () => {
  it("stays short enough to be read in full", () => {
    expect(text.split("\n").length).toBeLessThan(200);
  });

  it("names only npm scripts that exist", () => {
    const used = [...text.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(3);
    for (const s of used) expect(scripts, `npm run ${s}`).toContain(s);
  });

  it("points only at files and directories that exist", () => {
    const paths = [...text.matchAll(/`((?:src|test|docs|plugin|examples|scripts|python|\.github|\.claude-plugin)\/[\w./-]*)`/g)].map((m) => m[1]!);
    expect(paths.length).toBeGreaterThan(10);
    for (const p of paths) expect(existsSync(path.join(root, p)), p).toBe(true);
  });

  it.skipIf(!process.features.typescript)("uses only commands and flags the CLI has", { timeout: 30_000 }, async () => {
    const run = promisify(execFile);
    const help = async (...args: string[]) => (await run(process.execPath, [path.join(root, "src", "cli.ts"), ...args, "--help"])).stdout;
    const commands = [...text.matchAll(/node (?:src\/cli\.ts|dist\/cli\.js) +([a-z][\w-]*)([^\n;&|`\\]*)/g)];
    expect(commands.length).toBeGreaterThan(2);
    for (const [line, command, rest] of commands) {
      const options = (await help(command!)).split("Options:")[1] ?? "";
      for (const flag of rest!.matchAll(/(?<![\w-])(--?[a-zA-Z][\w-]*)/g)) {
        expect(options, `${line.trim()}: ${flag[1]}`).toMatch(new RegExp(`(?<![\\w-])${flag[1]}\\b`));
      }
    }
  });
});
