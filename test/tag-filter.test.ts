import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { loadDomain } from "../src/spec/load.ts";

// `run --tag a,b` runs only the tasks carrying at least one of those tags, and with `--tasks`, only the tasks in
// both. Every problem with the selection fails the command (exit 2) before any trial runs and before anything is written.

const cli = path.resolve("src/cli.ts");
const tmp = (prefix: string) => mkdtempSync(path.join(tmpdir(), prefix));

/** A domain with a tagged and an untagged task, both passed by a do-nothing agent. */
const NOTES = `name: tag-filter
policy: Take notes only when asked.
world:
  tables:
    notes: { key: id, rows: [] }
tools:
  - name: add_note
    description: Add a note.
    params: { id: { type: string }, text: { type: string } }
    ops: [{ create: notes, values: { id: $id, text: $text } }]
tasks:
  - id: tagged-one
    tags: [refusal]
    user: { instructions: Say hello and nothing else., script: ["Hello"] }
    expect: { not_called: [add_note] }
  - id: plain-one
    user: { instructions: Say hello and nothing else., script: ["Hello"] }
    expect: { not_called: [add_note] }
`;

describe.skipIf(!process.features.typescript)("`sandtable run --tag`", () => {
  const run = (domain: string, ...args: string[]) => {
    const out = path.join(tmp("sandtable-tag-"), "out");
    return promisify(execFile)(process.execPath, [cli, "run", domain, "--agent", "scripted:careful", "--user", "scripted", "--no-html", "-o", out, ...args]).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr, out }),
      (e: { code: number; stdout: string; stderr: string }) => ({ ...e, out }),
    );
  };
  const ran = (out: string): string[] => (JSON.parse(readFileSync(path.join(out, "results.json"), "utf8")) as { tasks: { id: string }[] }).tasks.map((t) => t.id);
  let ids: string[];
  let tagged: (tag: string) => string[];
  let notHandoff: string;

  beforeAll(async () => {
    const freight = await loadDomain(path.resolve("examples/freight"));
    ids = freight.tasks.map((t) => t.id);
    tagged = (tag) => freight.tasks.filter((t) => t.tags.includes(tag)).map((t) => t.id);
    notHandoff = freight.tasks.find((t) => !t.tags.includes("handoff"))!.id;
  });

  it("runs every task carrying any of the tags, in spec order", async () => {
    const r = await run("examples/freight", "--tag", "handoff,callback");
    expect(r.code).toBe(0);
    const want = new Set([...tagged("handoff"), ...tagged("callback")]);
    expect(want.size).toBeGreaterThan(tagged("handoff").length);
    expect(ran(r.out)).toEqual(ids.filter((id) => want.has(id)));
  });

  it("adds the tags of a repeated --tag, as --floor adds floors", async () => {
    const r = await run("examples/freight", "--tag", "handoff", "--tag", "callback");
    expect(r.code).toBe(0);
    const want = new Set([...tagged("handoff"), ...tagged("callback")]);
    expect(ran(r.out)).toEqual(ids.filter((id) => want.has(id)));
  });

  it("runs only the tasks both --tasks and --tag select", async () => {
    const [handoff] = tagged("handoff");
    const r = await run("examples/freight", "--tag", "handoff", "-t", `${handoff},${notHandoff}`);
    expect(r.code).toBe(0);
    expect(ran(r.out)).toEqual([handoff]);
  });

  it("selects tasks without tags as untagged, the name --floor and the By tag table give them", async () => {
    const dir = tmp("sandtable-tag-domain-");
    writeFileSync(path.join(dir, "sandtable.yaml"), NOTES);
    await promisify(execFile)(process.execPath, [cli, "run", dir, "--agent", "noop", "--user", "scripted", "--no-html", "-o", path.join(dir, "out"), "--tag", "untagged", "--floor", "untagged=100"]);
    expect(ran(path.join(dir, "out"))).toEqual(["plain-one"]);
  });

  it("checks --floor against the tasks the tags select", async () => {
    // No callback task is tagged negotiation.
    const r = await run("examples/freight", "--tag", "callback", "--floor", "negotiation=100");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^--floor: no task in this run is tagged "negotiation" \(its tags: /);
    expect((await run("examples/freight", "--tag", "callback", "--floor", "callback=100")).code).toBe(0);
  });

  it("refuses a tag no task carries before any trial runs, with nothing written", async () => {
    const r = await run("examples/freight", "--tag", "refusl");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^--tag: no task in freight-carrier-sales is tagged "refusl" \(its tags: alternatives, callback, /);
    expect(r.stdout).toBe("");
    expect(existsSync(r.out)).toBe(false);
    // freight tags every task, so no task is untagged.
    expect((await run("examples/freight", "--tag", "untagged")).stderr).toContain('is tagged "untagged"');
  });

  it("refuses --tasks and --tag with no task in common, and an empty --tag", async () => {
    const r = await run("examples/freight", "--tag", "handoff", "-t", notHandoff);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`--tasks and --tag have no task in common: none of ${notHandoff} is tagged handoff`);
    expect(existsSync(r.out)).toBe(false);
    const empty = await run("examples/freight", "--tag", ",");
    expect(empty.code).toBe(2);
    expect(empty.stderr).toContain("give at least one tag");
  });

  it("still names an unknown task id, with or without --tag", async () => {
    for (const args of [["-t", "nope"], ["-t", "nope", "--tag", "handoff"]]) {
      const r = await run("examples/freight", ...args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.stderr, args.join(" ")).toContain("unknown task id(s): nope");
    }
  });
});
