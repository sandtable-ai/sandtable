import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// `npm version` bumps package.json; the CLI must report the same version, from source and from the build.

const root = process.cwd();
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };

describe("sandtable --version", () => {
  it("has no hard-coded version string", () => {
    expect(readFileSync(path.join(root, "src", "cli.ts"), "utf8")).not.toMatch(/\.version\("\d/);
  });

  it.skipIf(!process.features.typescript)("matches package.json", async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, "src", "cli.ts"), "--version"]);
    expect(stdout.trim()).toBe(version);
  });
});
