import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// `npm version` runs scripts/sync-version.mjs, and CI runs it with --check. Each case runs the
// script on a copy of the files it syncs, so a field it can no longer find never passes as "in sync".

const root = process.cwd();
const FILES = ["package.json", "python/pyproject.toml", "python/src/sandtable_ai/__init__.py", "plugin/.claude-plugin/plugin.json", ".claude-plugin/marketplace.json"];

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
/** The release tag the marketplace installs the plugin from. */
const pluginRef = (dir: string) =>
  (JSON.parse(read(dir, ".claude-plugin/marketplace.json")) as { plugins: { name: string; source: { ref?: string } }[] }).plugins.find((p) => p.name === "sandtable")!.source.ref;

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
    // Versions the repository never has, so each starts out of sync whatever the current version is.
    for (const [npm, pep440] of [["98.7.6", "98.7.6"], ["98.8.0-alpha.3", "98.8.0a3"], ["99.0.0-rc.1", "99.0.0rc1"]] as const) {
      const dir = copy();
      setVersion(dir, npm);
      expect((await sync(dir, "--check")).code).toBe(1);
      expect((await sync(dir)).code).toBe(0);
      expect(read(dir, "python/pyproject.toml")).toMatch(new RegExp(`^version = "${pep440}"$`, "m"));
      expect(read(dir, "python/src/sandtable_ai/__init__.py")).toContain(`__version__ = "${pep440}"`);
      expect(read(dir, "python/src/sandtable_ai/__init__.py")).toContain(`NPM_VERSION = "${npm}"`);
      expect(JSON.parse(read(dir, "plugin/.claude-plugin/plugin.json")).version).toBe(npm);
      // A stable release moves the marketplace to its tag; a pre-release keeps the last stable one, which npm's latest serves.
      expect(pluginRef(dir)).toBe(npm.includes("-") ? pluginRef(root) : `v${npm}`);
      expect((await sync(dir, "--check")).code).toBe(0);
    }
  });

  it("keeps the rest of marketplace.json as it is", async () => {
    const dir = copy();
    const before = read(dir, ".claude-plugin/marketplace.json");
    setVersion(dir, "9.9.9");
    await sync(dir);
    const after = read(dir, ".claude-plugin/marketplace.json");
    expect(after.replace('"v9.9.9"', "X")).toBe(before.replace(/"ref": "[^"]*"/, '"ref": X'));
  });

  it("fails --check and the sync when a pre-release finds the marketplace on a tag that isn't a stable release", async () => {
    const dir = copy();
    setVersion(dir, "0.4.0-alpha.1");
    edit(dir, ".claude-plugin/marketplace.json", (s) => s.replace(/"ref": "[^"]*"/, '"ref": "v0.4.0-alpha.0"'));
    for (const args of [["--check"], []]) {
      const r = await sync(dir, ...args);
      expect(r.code).toBe(1);
      expect(r.out).toContain(`.claude-plugin/marketplace.json: "ref" of the sandtable plugin's source is v0.4.0-alpha.0, expected a stable release tag`);
    }
  });

  it("names a marketplace that installs the plugin from something other than a tag", async () => {
    const dir = copy();
    edit(dir, ".claude-plugin/marketplace.json", (s) => s.replace(/"source": \{[^}]*\}/, '"source": "./plugin"'));
    const r = await sync(dir, "--check");
    expect(r.code).toBe(1);
    expect(r.out).toContain(`.claude-plugin/marketplace.json: no "ref" of the sandtable plugin's source found to sync`);
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

  it("writes no file when a field in a later file can't be found", async () => {
    const dir = copy();
    setVersion(dir, "0.4.0");
    const pyproject = read(dir, "python/pyproject.toml");
    edit(dir, "python/src/sandtable_ai/__init__.py", (s) => s.replace(/^NPM_VERSION = "[^"]*"$/m, "NPM_VERSION = '0.1.0'"));
    const r = await sync(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("python/src/sandtable_ai/__init__.py: no NPM_VERSION found to sync");
    expect(read(dir, "python/pyproject.toml")).toBe(pyproject);
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
