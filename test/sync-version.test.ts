import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// `npm version` runs scripts/sync-version.mjs, and CI runs it with --check. Each case runs the
// script on a copy of the files it syncs, so a field it can no longer find never passes as "in sync".

const root = process.cwd();
const FILES = ["package.json", "python/pyproject.toml", "python/src/sandtable_ai/__init__.py", "plugin/.claude-plugin/plugin.json"];

function copy(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sandtable-sync-"));
  for (const f of ["scripts/sync-version.mjs", ...FILES]) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    cpSync(path.join(root, f), path.join(dir, f));
  }
  return dir;
}

const edit = (dir: string, file: string, fn: (s: string) => string) =>
  writeFileSync(path.join(dir, file), fn(readFileSync(path.join(dir, file), "utf8")));
const read = (dir: string, file: string) => readFileSync(path.join(dir, file), "utf8");
const setVersion = (dir: string, v: string) => edit(dir, "package.json", (s) => s.replace(/"version": "[^"]*"/, `"version": "${v}"`));

async function sync(dir: string, ...args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [path.join(dir, "scripts/sync-version.mjs"), ...args]);
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, out: e.stdout + e.stderr };
  }
}

describe("scripts/sync-version.mjs", () => {
  it("passes --check on the repository as it is", async () => {
    expect((await sync(copy(), "--check")).code).toBe(0);
  });

  it("syncs a release and a pre-release, then passes --check", async () => {
    for (const [npm, pep440] of [["0.1.0", "0.1.0"], ["0.2.0-alpha.3", "0.2.0a3"], ["1.0.0-rc.1", "1.0.0rc1"]] as const) {
      const dir = copy();
      setVersion(dir, npm);
      expect((await sync(dir, "--check")).code).toBe(1);
      expect((await sync(dir)).code).toBe(0);
      expect(read(dir, "python/pyproject.toml")).toMatch(new RegExp(`^version = "${pep440}"$`, "m"));
      expect(read(dir, "python/src/sandtable_ai/__init__.py")).toContain(`__version__ = "${pep440}"`);
      expect(read(dir, "python/src/sandtable_ai/__init__.py")).toContain(`NPM_VERSION = "${npm}"`);
      expect(JSON.parse(read(dir, "plugin/.claude-plugin/plugin.json")).version).toBe(npm);
      expect((await sync(dir, "--check")).code).toBe(0);
    }
  });

  it("keeps the rest of plugin.json as it is", async () => {
    const dir = copy();
    const before = read(dir, "plugin/.claude-plugin/plugin.json");
    setVersion(dir, "9.9.9");
    await sync(dir);
    const after = read(dir, "plugin/.claude-plugin/plugin.json");
    expect(after.replace('"9.9.9"', "X")).toBe(before.replace(/"version": "[^"]*"/, '"version": X'));
  });

  it("fails --check and the sync when a field moved out of its pattern", async () => {
    const dir = copy();
    setVersion(dir, "0.1.0");
    // A stale value in a shape the old regexes skipped: single quotes, and "version" as the last key.
    edit(dir, "python/pyproject.toml", (s) => s.replace(/^version = "[^"]*"$/m, "version = '0.1.0a1'"));
    edit(dir, "plugin/.claude-plugin/plugin.json", (s) => {
      const { version, ...rest } = JSON.parse(s) as { version: string };
      return JSON.stringify({ ...rest, version }, null, 2);
    });
    for (const args of [["--check"], []]) {
      const r = await sync(dir, ...args);
      expect(r.code).toBe(1);
      expect(r.out).toContain("python/pyproject.toml: no version found to sync");
    }
  });

  it("names each stale field under --check", async () => {
    const dir = copy();
    setVersion(dir, "0.3.0");
    const r = await sync(dir, "--check");
    expect(r.code).toBe(1);
    expect(r.out).toContain("python/src/sandtable_ai/__init__.py: NPM_VERSION is");
    expect(r.out).toContain("expected 0.3.0");
  });
});
