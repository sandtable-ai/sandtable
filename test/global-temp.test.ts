import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { removeTempFolder } from "./global-temp.ts";

/** What's left of `dir` beside it, under its own name or the one it's removed under. */
const leftovers = (dir: string) => readdirSync(path.dirname(dir)).filter((name) => name.startsWith(path.basename(dir)));

describe("the run's temp folder", () => {
  // These two rest on vitest building a worker's environment after globalSetup runs. If an upgrade changes
  // that, every test's folders go back to the system's temp directory, and nothing else would say so.
  it("is where a test's temp folders go", () => {
    expect(path.basename(tmpdir())).toMatch(/^sandtable-tests-/);
  });

  it("is where the temp folders of a process a test starts go", () => {
    expect(execFileSync(process.execPath, ["-p", "require('node:os').tmpdir()"], { encoding: "utf8" }).trim()).toBe(tmpdir());
  });

  it("is removed with a read-only folder in it, which a test that timed out leaves behind", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sandtable-teardown-"));
    const readOnly = path.join(dir, "out", "read-only");
    mkdirSync(readOnly, { recursive: true });
    writeFileSync(path.join(readOnly, "results.json"), "{}");
    chmodSync(readOnly, 0o555);

    removeTempFolder(dir);

    expect(leftovers(dir)).toEqual([]);
  });

  it("is removed while a process is still writing in it, and that process stops", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sandtable-teardown-"));
    const writes = `const fs = require("node:fs"), path = require("node:path");
      for (;;) fs.writeFileSync(path.join(fs.mkdtempSync(path.join(${JSON.stringify(dir)}, "stray-")), "results.json"), "{}");`;
    const stray = spawn(process.execPath, ["-e", writes], { stdio: "ignore" });
    const ended = new Promise((resolve) => stray.once("exit", resolve));
    try {
      await vi.waitFor(() => expect(readdirSync(dir)).not.toEqual([]), { timeout: 20_000 });

      removeTempFolder(dir);

      expect(leftovers(dir)).toEqual([]);
      await ended;
      expect(existsSync(dir)).toBe(false);
    } finally {
      stray.kill("SIGKILL");
    }
  });

  it("warns about a folder it can't remove, so the run keeps the result its tests gave it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = path.join(tmpdir(), "sandtable-teardown-never-made");
    try {
      expect(() => removeTempFolder(dir)).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(dir));
    } finally {
      warn.mockRestore();
    }
  });
});
