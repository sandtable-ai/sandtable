import { cpSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DomainError, loadDomain } from "../src/spec/load.ts";
import { version } from "../src/version.ts";

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
    edit(path.join(dir, "sandtable.yaml"), /^policy: \.\/policy\.md$/m, "policy: Follow the steps in policy.md");
    expect((await loadDomain(dir)).policy).toBe("Follow the steps in policy.md");
  });

  it("inlines a file whose name has spaces", async () => {
    const dir = copyOfClinic();
    renameSync(path.join(dir, "policy.md"), path.join(dir, "Front Desk SOP.md"));
    edit(path.join(dir, "sandtable.yaml"), /^policy: \.\/policy\.md$/m, "policy: ./Front Desk SOP.md");
    expect((await loadDomain(dir)).policy).toBe(readFileSync(path.resolve("examples/clinic/policy.md"), "utf8"));
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

describe("loadDomain schema and cross-reference errors", () => {
  it("name the included file an item comes from, and sandtable.yaml for its own keys", async () => {
    const dir = copyOfClinic();
    edit(path.join(dir, "tasks.yaml"), /^- id: /m, "- critcal: true\n  id: ");
    edit(path.join(dir, "sandtable.yaml"), /^name: /m, "nmae: x\nname: ");
    const message = ((await loadDomain(dir).catch((e: unknown) => e)) as Error).message;
    expect(message).toContain(`${path.join(dir, "tasks.yaml")}:\n✖ Unrecognized key: "critcal"`);
    expect(message).toContain(`${path.join(dir, "sandtable.yaml")}:\n✖ Unrecognized key: "nmae"`);
    // Last, the installed version, so a key from a later release reads differently from a typo.
    expect(message.split("\n").at(-1)).toBe(
      `sandtable-ai ${version} doesn't know these keys: check their spelling, or whether a later release added them (CHANGELOG.md, or \`npx sandtable-ai@latest validate ${dir}\`).`,
    );
  });

  it("say once which version doesn't know a single unknown key", async () => {
    const dir = copyOfClinic();
    edit(path.join(dir, "sandtable.yaml"), /^name: /m, "nmae: x\nname: ");
    const message = ((await loadDomain(dir).catch((e: unknown) => e)) as Error).message;
    expect(message).toContain(`\nsandtable-ai ${version} doesn't know this key: check its spelling, or whether a later release added it`);
  });

  it("print the validate command with the path as given, quoted when it needs to be, so it runs as printed", async () => {
    const dir = copyOfClinic();
    edit(path.join(dir, "sandtable.yaml"), /^name: /m, "nmae: x\nname: ");
    const spaced = `${dir} copy`;
    renameSync(dir, spaced);
    const message = ((await loadDomain(spaced).catch((e: unknown) => e)) as Error).message;
    expect(message).toContain(`\`npx sandtable-ai@latest validate '${spaced}'\``);
  });

  it("leave other schema errors without the version line", async () => {
    const dir = copyOfClinic();
    edit(path.join(dir, "sandtable.yaml"), /^name: .*$/m, "name: 42");
    const message = ((await loadDomain(dir).catch((e: unknown) => e)) as Error).message;
    expect(message).not.toContain("doesn't know");
  });

  it("name the included tasks file for a task's cross-reference problem", async () => {
    const dir = copyOfClinic();
    edit(path.join(dir, "tasks.yaml"), /^ {2}persona: \S+$/m, "  persona: nobody-at-all");
    await expect(loadDomain(dir)).rejects.toThrow(new RegExp(`^${path.join(dir, "tasks.yaml").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\n {2}- tasks\\.[\\w-]+: unknown persona "nobody-at-all"$`));
  });
});
