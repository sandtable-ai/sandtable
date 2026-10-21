import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

// Exit statuses, as grep and diff use them: 0 when the command did its job and every gate passed, 1 when a
// gate failed on a complete result, 2 when the command couldn't do its job. One case of each per command.

const cli = path.resolve("src/cli.ts");
const example = path.resolve("examples/freight");
const tasks = "expired-insurance,book-at-posted-rate";
// No key or AWS setting: a model call, if one slipped through, fails instead of costing money.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("AWS_") && !["ANTHROPIC_API_KEY", "OPENAI_API_KEY"].includes(k)));

let dir: string;

async function sandtable(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return promisify(execFile)(process.execPath, [cli, ...args], { env, cwd: dir }).then(
    (r) => ({ code: 0, ...r }),
    (e: { code: number; stdout: string; stderr: string }) => e,
  );
}

/** A copy of the freight example whose sandtable.yaml is edited by `edit`. */
function freightWith(name: string, edit: (yaml: string) => string): string {
  const copy = path.join(dir, name);
  cpSync(example, copy, { recursive: true });
  const file = path.join(copy, "sandtable.yaml");
  writeFileSync(file, edit(readFileSync(file, "utf8")));
  return copy;
}

const run = (...args: string[]) => sandtable("run", example, "--user", "scripted", "-t", tasks, "--no-html", "-o", path.join(dir, "out"), ...args);

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sandtable-exit-"));
  // An agent whose every trial crashes, as one without credentials does, and one that crashes in its second
  // trial of each task only, as a rate limit that outlasted the retries does.
  writeFileSync(path.join(dir, "crash.mjs"), 'export default { name: "crash", createSession: async () => ({ reply: async () => { throw new Error("no credentials"); } }) };\n');
  writeFileSync(
    path.join(dir, "flaky.mjs"),
    'export default { name: "flaky", createSession: async (ctx) => ({ reply: async () => { if (ctx.sessionId.endsWith("#1")) throw new Error("429 rate limited"); return "Sorry, I can\'t help with that."; } }) };\n',
  );
});

describe.skipIf(!process.features.typescript)("exit status", () => {
  describe("0: the command did its job and every gate passed", () => {
    it("help and --version", async () => {
      for (const args of [["--help"], ["--version"], ["help", "run"], ["run", "--help"]]) expect((await sandtable(...args)).code, args.join(" ")).toBe(0);
    });

    it("validate, lint and a run whose gates pass", async () => {
      expect((await sandtable("validate", example, "--strict")).code).toBe(0);
      expect((await sandtable("lint", example)).code).toBe(0);
      expect((await run("--agent", "scripted:careful", "--fail-under", "100")).code).toBe(0);
    });
  });

  describe("1: a gate failed on a complete result", () => {
    it("run below --fail-under", async () => {
      // The do-nothing agent passes the refusal and fails the booking: pass^1 50%.
      const r = await run("--agent", "noop", "--fail-under", "60");
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("is below --fail-under 60.0%");
    });

    it("run with a failed critical task", async () => {
      const r = await run("--agent", "scripted:naive");
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("critical task(s) did not pass every trial: expired-insurance");
    });

    it("validate --strict with a drafted item pending review", async () => {
      const pending = freightWith("pending", (y) => y.replace(/^(invariants:\n  - id: [^\n]+\n)/m, "$1    review: pending\n"));
      expect((await sandtable("validate", pending)).code).toBe(0);
      const r = await sandtable("validate", pending, "--strict");
      expect(r.code).toBe(1);
      expect(r.stdout).toContain("pending review");
    });

    it("validate and lint on a domain that exists but is invalid", async () => {
      const invalid = freightWith("invalid", (y) => y.replace(/^name: .*$/m, "$&\nbogus_key: 1"));
      for (const command of ["validate", "lint"]) {
        const r = await sandtable(command, invalid);
        expect(r.code, command).toBe(1);
        expect(r.stderr, command).toContain("Invalid domain:");
      }
    });

    it("lint errors", async () => {
      const ungraded = freightWith("ungraded", (y) => y);
      const tasksFile = path.join(ungraded, "tasks.yaml");
      writeFileSync(tasksFile, `${readFileSync(tasksFile, "utf8")}\n- id: grades-nothing\n  user: { instructions: "Ask about loads.", script: [Hi] }\n  expect: {}\n`);
      const r = await sandtable("lint", ungraded);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain("nothing is graded");
    });
  });

  describe("2: the command couldn't do its job", () => {
    it("a usage error, keeping commander's message", async () => {
      const cases: [string[], string][] = [
        [[], "Usage: sandtable"],
        [["nope"], "unknown command 'nope'"],
        [["run"], "missing required argument 'domain'"],
        [["run", example, "--bogus"], "unknown option '--bogus'"],
        [["run", example, "-k", "zero"], "must be a positive integer"],
        [["leaderboard", example], "required option '-m, --models <file>' not specified"],
      ];
      for (const [args, message] of cases) {
        const r = await sandtable(...args);
        expect(r.code, args.join(" ")).toBe(2);
        expect(r.stderr, args.join(" ")).toContain(message);
      }
    });

    it("a path with no domain at it, for validate and lint too", async () => {
      for (const command of ["validate", "lint", "run", "review"]) {
        const r = await sandtable(command, path.join(dir, "nothing-here"));
        expect(r.code, command).toBe(2);
        expect(r.stderr, command).toContain("no sandtable.yaml found");
      }
    });

    it("an invalid domain for any command other than validate and lint", async () => {
      const invalid = freightWith("invalid-run", (y) => y.replace(/^name: .*$/m, "$&\nbogus_key: 1"));
      const r = await sandtable("run", invalid, "--agent", "noop", "--user", "scripted", "--no-html");
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("Invalid domain:");
    });

    it("a missing file", async () => {
      expect((await sandtable("report", path.join(dir, "nope.json"))).code).toBe(2);
      expect((await sandtable("regrade", path.join(dir, "nope.json"), "-d", example)).code).toBe(2);
      expect((await sandtable("init", "--sop", path.join(dir, "nope.md"), "-o", path.join(dir, "draft"))).code).toBe(2);
    });

    it("an agent that can't be built", async () => {
      const r = await run("--agent", "nonsense");
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("unknown agent");
    });

    it("a run in which every trial ended in an error", async () => {
      const r = await run("--agent", path.join(dir, "crash.mjs"));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("Every trial ended in an error");
    });

    it("an incomplete run with skipped trials, even when a gate failed too", async () => {
      const r = await run("--agent", path.join(dir, "flaky.mjs"), "-k", "2", "--fail-under", "100");
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("this run is incomplete: rerun it");
      // The gate that failed is still reported.
      expect(r.stderr).toContain("is below --fail-under 100.0%");
    });
  });
});
