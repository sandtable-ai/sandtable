import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { loadDomain } from "../src/spec/load.ts";

// `--tasks` on `run` and `leaderboard` adds the ids of every repeat, as `--tag` and `--floor` do. An empty value still
// runs every task, as before 1.1, but warns that sandtable-ai 2.0 will refuse it (#403).

const cli = path.resolve("src/cli.ts");
const tmp = (prefix: string) => mkdtempSync(path.join(tmpdir(), prefix));
const WARNING = "warning: an empty --tasks value is deprecated; in sandtable-ai 2.0 it will be a usage error (exit 2). To run every task, leave --tasks out.";

const exec = (args: string[], cwd?: string) =>
  promisify(execFile)(process.execPath, [cli, ...args], cwd ? { cwd } : {}).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (e: { code: number; stdout: string; stderr: string }) => e,
  );
const ids = (results: string): string[] => (JSON.parse(readFileSync(results, "utf8")) as { tasks: { id: string }[] }).tasks.map((t) => t.id);

describe.skipIf(!process.features.typescript)("a repeated or empty --tasks", () => {
  let all: string[];
  const run = (...args: string[]) => {
    const out = path.join(tmp("sandtable-tasks-"), "out");
    return exec(["run", "examples/freight", "--agent", "scripted:careful", "--user", "scripted", "--no-html", "-o", out, ...args]).then((r) => ({ ...r, out }));
  };

  beforeAll(async () => {
    all = (await loadDomain(path.resolve("examples/freight"))).tasks.map((t) => t.id);
  });

  it("runs every task a repeated --tasks names, each once, in spec order", async () => {
    const r = await run("--tasks", "expired-insurance", "--tasks", "book-at-posted-rate,expired-insurance");
    expect(r.code).toBe(0);
    expect(ids(path.join(r.out, "results.json"))).toEqual(all.filter((id) => ["book-at-posted-rate", "expired-insurance"].includes(id)));
    expect(r.stderr).not.toContain("warning:");
  });

  it("runs a task named twice once", async () => {
    const r = await run("--tasks", "book-at-posted-rate", "--tasks", "book-at-posted-rate");
    expect(r.code).toBe(0);
    expect(ids(path.join(r.out, "results.json"))).toEqual(["book-at-posted-rate"]);
  });

  it("runs every task on an empty --tasks, as before, and warns once that 2.0 will refuse it", async () => {
    const r = await run("--tasks", "", "--tasks", " , ");
    expect(r.code).toBe(0);
    expect(ids(path.join(r.out, "results.json"))).toEqual(all);
    expect(r.stderr.split("\n").filter((l) => l === WARNING)).toHaveLength(1);
  });

  it("adds nothing for an empty repeat, and still warns", async () => {
    const r = await run("--tasks", "book-at-posted-rate", "--tasks", "");
    expect(r.code).toBe(0);
    expect(ids(path.join(r.out, "results.json"))).toEqual(["book-at-posted-rate"]);
    expect(r.stderr).toContain(WARNING);
  });

  it("adds the ids of a repeated --tasks on leaderboard too, for every model and the baseline", async () => {
    const dir = tmp("sandtable-tasks-lb-");
    writeFileSync(path.join(dir, "models.yaml"), "models:\n  - { label: Careful rules, agent: scripted:careful }\n");
    const r = await exec(["leaderboard", path.resolve("examples/freight"), "-m", "models.yaml", "-u", "scripted", "-k", "1", "-t", "no-mc-number", "-t", "expired-insurance", "-o", "board"], dir);
    expect(r.code).toBe(0);
    expect(ids(path.join(dir, "board", "careful-rules", "results.json"))).toEqual(all.filter((id) => ["no-mc-number", "expired-insurance"].includes(id)));
  });
});
