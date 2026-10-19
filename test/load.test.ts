import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DomainError, loadDomain } from "../src/spec/load.ts";

// A domain's own files: sandtable.yaml and the policy, world or tasks files it includes.

function copyOfClinic(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sandtable-load-"));
  cpSync(path.resolve("examples/clinic"), dir, { recursive: true });
  return dir;
}

function edit(file: string, from: string | RegExp, to: string): void {
  const before = readFileSync(file, "utf8");
  const after = before.replace(from, to);
  expect(after).not.toBe(before);
  writeFileSync(file, after);
}

describe("loadDomain includes", () => {
  it("inlines policy and tasks from their own files", async () => {
    const d = await loadDomain(path.resolve("examples/clinic"));
    expect(d.policy).toBe(readFileSync(path.resolve("examples/clinic/policy.md"), "utf8"));
    expect(d.tasks.length).toBeGreaterThan(0);
  });

  it("rejects a misspelled policy path instead of using the path as the policy", async () => {
    const dir = copyOfClinic();
    edit(path.join(dir, "sandtable.yaml"), /^policy: \.\/policy\.md$/m, "policy: ./polcy.md");
    const err = await loadDomain(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as Error).message).toContain("policy: ./polcy.md not found (looked for ");
  });

  it("rejects a missing tasks file by name", async () => {
    const dir = copyOfClinic();
    edit(path.join(dir, "sandtable.yaml"), /^tasks: \.\/tasks\.yaml$/m, "tasks: ./task.yaml");
    await expect(loadDomain(dir)).rejects.toThrow(/tasks: \.\/task\.yaml not found/);
  });

  it("keeps inline text that merely mentions a file", async () => {
    const dir = copyOfClinic();
    edit(path.join(dir, "sandtable.yaml"), /^policy: \.\/policy\.md$/m, "policy: Follow the steps in policy.md.");
    expect((await loadDomain(dir)).policy).toBe("Follow the steps in policy.md.");
  });
});

describe("loadDomain YAML errors", () => {
  it("name sandtable.yaml", async () => {
    const dir = copyOfClinic();
    writeFileSync(path.join(dir, "sandtable.yaml"), "name: x\nworld:\n  tables: {\n  bad: [\n");
    const err = await loadDomain(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as Error).message).toMatch(new RegExp(`^${path.join(dir, "sandtable.yaml").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: `));
  });

  it("name the included file they come from", async () => {
    const dir = copyOfClinic();
    writeFileSync(path.join(dir, "tasks.yaml"), "- id: a\n  bad: : :\n");
    await expect(loadDomain(dir)).rejects.toThrow(`${path.join(dir, "tasks.yaml")}: Nested mappings are not allowed`);
  });
});
