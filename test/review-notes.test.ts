import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { appendToDomainList } from "../src/init/merge.ts";
import { loadDomain } from "../src/spec/load.ts";
import { reviewNotes } from "../src/spec/notes.ts";

// `init` writes what a person must check as `# TODO(review):` comments above a drafted item. `review` prints them
// under the item, so its list says what to do, not only what is pending.

const freight = path.resolve("examples/freight");

async function domainWithNotedTask(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-review-"));
  await cp(freight, dir, { recursive: true });
  const base = (await loadDomain(dir)).tasks[0]!;
  const tasks = [
    { ...base, id: "drafted-one", review: "pending" as const, source: { file: "chat-7.txt", quote: "Hi, it's about L-1001." } },
    { ...base, id: "drafted-two", review: "pending" as const },
  ];
  await appendToDomainList(dir, "tasks", tasks, undefined, {
    "drafted-one": ['copied from chat-7.txt: replace "Priya Halvorsen" with a fictional value (in the caller\'s instructions)'],
    "drafted-two": ["lint: reference does not pass. Fix the expectation, the seed rows or the reference."],
  });
  return dir;
}

describe("review notes", () => {
  it("reads the notes above each drafted task, from the tasks file", async () => {
    const notes = await reviewNotes(await domainWithNotedTask());
    expect(notes.get("task drafted-one")).toEqual(['copied from chat-7.txt: replace "Priya Halvorsen" with a fictional value (in the caller\'s instructions)']);
    expect(notes.get("task drafted-two")).toEqual(["lint: reference does not pass. Fix the expectation, the seed rows or the reference."]);
    expect(notes.has("task book-at-posted-rate")).toBe(false);
  });

  it("reads a tool's notes in sandtable.yaml, and keeps only TODO(review) lines", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-review-"));
    await cp(freight, dir, { recursive: true });
    const file = path.join(dir, "sandtable.yaml");
    const text = await readFile(file, "utf8");
    await writeFile(file, text.replace(/^ {2}- name: book_load$/m, "  # A plain comment.\n  # TODO(review): The API can answer 409: encode it as a check.\n  - name: book_load"));
    expect((await reviewNotes(dir)).get("tool book_load")).toEqual(["The API can answer 409: encode it as a check."]);
  });

  it.skipIf(!process.features.typescript)("sandtable review prints each pending task's notes under it", async () => {
    const dir = await domainWithNotedTask();
    const { stdout } = await promisify(execFile)(process.execPath, [path.resolve("src/cli.ts"), "review", dir]);
    expect(stdout).toContain(
      '- task drafted-one  (chat-7.txt)\n    "Hi, it\'s about L-1001."\n    TODO(review): copied from chat-7.txt: replace "Priya Halvorsen" with a fictional value (in the caller\'s instructions)\n',
    );
    expect(stdout).toContain("- task drafted-two\n    TODO(review): lint: reference does not pass.");
  });
});
