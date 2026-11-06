import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { explainClaudeError, withHints, type ClaudeClient } from "../src/sim/claude.ts";
import { httpAgent } from "../src/sim/http.ts";
import { importOptional } from "../src/sim/optional.ts";

// The errors a new user hits first must say what to do, not what failed inside a dependency.

const NO_AUTH =
  'Could not resolve authentication method. Expected one of apiKey, authToken, credentials, config, or profile to be set. Or for one of the "X-Api-Key" or "Authorization" headers to be explicitly omitted';

describe("Claude credential errors", () => {
  it("names the key to set when the Anthropic SDK finds no credentials", () => {
    const err = explainClaudeError(new Error(NO_AUTH), "anthropic") as Error;
    expect(err.message).toMatch(/^no Anthropic credentials: set ANTHROPIC_API_KEY/);
    expect(err.message).toContain("--provider bedrock");
  });

  it("says which key was rejected on a 401", () => {
    const err = explainClaudeError(Object.assign(new Error("invalid x-api-key"), { status: 401 }), "anthropic") as Error;
    expect(err.message).toMatch(/rejected the credentials \(401\): check ANTHROPIC_API_KEY\. invalid x-api-key/);
  });

  it("names the AWS settings when Bedrock finds no credentials", () => {
    const err = explainClaudeError(new Error("Failed to resolve AWS credentials from the credential provider chain."), "bedrock") as Error;
    expect(err.message).toMatch(/^no AWS credentials for --provider bedrock: pass --aws-profile or set AWS_PROFILE/);
  });

  it("passes other errors through unchanged", () => {
    const original = Object.assign(new Error("overloaded"), { status: 529 });
    expect(explainClaudeError(original, "anthropic")).toBe(original);
    expect(explainClaudeError(original, "bedrock")).toBe(original);
  });

  it("rewrites the error of every messages call on the client", async () => {
    const fake = { beta: { messages: { create: async () => Promise.reject(new Error(NO_AUTH)), parse: () => Promise.resolve("ok") } } };
    const client = withHints(fake as unknown as ClaudeClient, "anthropic");
    await expect(client.beta.messages.create({} as never)).rejects.toThrow(/set ANTHROPIC_API_KEY/);
    await expect(client.beta.messages.parse({} as never)).resolves.toBe("ok");
  });
});

describe("optional packages", () => {
  it("say how to install them next to sandtable-ai, also under npx", async () => {
    const name = "sandtable-test-missing-package";
    const err = await importOptional(name, () => import(name), "--provider bedrock").catch((e: Error) => e);
    expect((err as Error).message).toContain(`--provider bedrock needs the optional package ${name}`);
    expect((err as Error).message).toContain(`npm install --save-dev sandtable-ai ${name}, then npx sandtable-ai <command>`);
    expect((err as Error).message).toContain(`npx -p sandtable-ai -p ${name} sandtable <command>`);
  });

  it("rethrow any other import error as is", async () => {
    const boom = new Error("boom");
    await expect(importOptional("x", () => Promise.reject(boom), "--x")).rejects.toBe(boom);
  });
});

describe("HTTP agent errors", () => {
  afterEach(() => vi.unstubAllGlobals());
  const ctx = { domain: {} as never, system: "", tools: [], sessionId: "r/t#0" };
  const noTools = async () => ({ ok: true });

  it("name the URL and the reason when the agent can't be reached", async () => {
    vi.stubGlobal("fetch", async () => Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })));
    const session = await httpAgent("http://localhost:8787/step").createSession(ctx);
    await expect(session.reply("hi", noTools)).rejects.toThrow("could not reach the agent at http://localhost:8787/step (ECONNREFUSED): is it running");
  });

  it("say when the agent does not answer with JSON", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>Not here</html>", { status: 200 }));
    const session = await httpAgent("http://localhost:8787/step").createSession(ctx);
    await expect(session.reply("hi", noTools)).rejects.toThrow("agent endpoint http://localhost:8787/step did not answer with JSON: <html>Not here</html>");
  });
});

describe.skipIf(!process.features.typescript)("CLI errors", () => {
  const cli = path.resolve("src/cli.ts");
  const fail = (args: string[]) =>
    promisify(execFile)(process.execPath, [cli, ...args]).then(
      () => ({ code: 0, stderr: "" }),
      (e: { code: number; stderr: string }) => e,
    );

  it("an unknown --agent lists the valid forms", async () => {
    const { code, stderr } = await fail(["run", "examples/freight", "--agent", "cluade", "--user", "scripted"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/^unknown agent "cluade": use claude, claude:<model>, .* or the path of a JS\/TS module \(there is no file at /);
  });

  it("report refuses a file that is not a results.json", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sandtable-report-"));
    writeFileSync(path.join(dir, "leaderboard.json"), JSON.stringify({ version: 1, rows: [] }));
    const { code, stderr } = await fail(["report", path.join(dir, "leaderboard.json")]);
    expect(code).toBe(2);
    expect(stderr).toContain("is not a results.json written by `sandtable run`");
    expect(stderr).toContain("it is a leaderboard's leaderboard.json: each model's results.json is in its folder");
  });

  it("report, regrade and run --baseline refuse a results.json from a newer format, before running anything", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sandtable-newer-"));
    const file = path.join(dir, "results.json");
    writeFileSync(file, readFileSync("plugin-evals/fixtures/wrenfield-run/results.json", "utf8").replace('"version": 1', '"version": 2'));
    const newer = `${file} is results.json format version 2, from a newer sandtable; this one reads format version 1.`;
    for (const args of [["report", file], ["regrade", file, "-d", "examples/freight"], ["run", "examples/freight", "--agent", "noop", "--user", "scripted", "--baseline", file]]) {
      const { code, stderr } = await fail(args);
      expect(code, args[0]).toBe(2);
      expect(stderr, args[0]).toContain(newer);
    }
  });

  describe("a path that names nothing says which option or argument it came from", () => {
    const tmp = () => mkdtempSync(path.join(tmpdir(), "sandtable-missing-"));
    const RESULTS_HINT = "(pass the results.json a run wrote: `sandtable run` writes to .sandtable/runs/ unless -o says otherwise)";
    const cases: [string, string[], string][] = [
      ["report", ["report", "nope/results.json"], `report: no file at nope/results.json ${RESULTS_HINT}`],
      ["regrade", ["regrade", "nope/results.json", "-d", "examples/freight"], `regrade: no file at nope/results.json ${RESULTS_HINT}`],
      ["run --prices", ["run", "examples/freight", "--agent", "noop", "--user", "scripted", "--prices", "nope.json"], "--prices: no file at nope.json"],
      ["run --baseline", ["run", "examples/freight", "--agent", "noop", "--user", "scripted", "--baseline", "nope/results.json"], `--baseline: no file at nope/results.json ${RESULTS_HINT}`],
      ["leaderboard -m", ["leaderboard", "examples/freight", "-m", "nope.yaml"], "--models: no file at nope.yaml"],
      ["leaderboard --prices", ["leaderboard", "examples/freight", "-m", "nope.yaml", "--prices", "nope.json"], "--prices: no file at nope.json"],
      ["init --openapi", ["init", "--openapi", "nope.yaml"], "--openapi: no file at nope.yaml"],
      ["init --sop", ["init", "--sop", "nope.md"], "--sop: no file at nope.md"],
      ["init --transcripts", ["init", "--transcripts", "nope/"], "--transcripts: no file or directory at nope/"],
    ];
    for (const [name, args, message] of cases) {
      it(name, async () => {
        const out = path.join(tmp(), "out");
        const { code, stderr } = await fail([...args, "-o", out]);
        expect(code).toBe(2);
        expect(stderr.trim()).toBe(message);
        // Nothing was drafted, run or written before the path was read.
        expect(existsSync(out)).toBe(false);
      });
    }

    it("init --transcripts fails before --openapi writes anything or --sop calls a model", async () => {
      const out = path.join(tmp(), "out");
      const sop = path.join(tmp(), "sop.md");
      writeFileSync(sop, "Always verify the carrier before booking.");
      const { code, stderr } = await fail(["init", "--openapi", "examples/freight/sandtable.yaml", "--sop", sop, "--transcripts", "nope/", "-o", out]);
      expect(code).toBe(2);
      expect(stderr.trim()).toBe("--transcripts: no file or directory at nope/");
      expect(existsSync(out)).toBe(false);
    });

    it("init --transcripts names a directory with no transcript in it", async () => {
      const dir = tmp();
      writeFileSync(path.join(dir, "notes.pdf"), "");
      const { code, stderr } = await fail(["init", "--transcripts", dir, "-o", path.join(tmp(), "out")]);
      expect(code).toBe(2);
      expect(stderr.trim()).toBe(`--transcripts: no .txt or .md file in ${dir}`);
    });

    it("report -o creates the directory it writes into, as run -o does", async () => {
      const dir = tmp();
      await promisify(execFile)(process.execPath, [cli, "run", "examples/freight", "-t", "book-at-posted-rate", "--agent", "scripted:careful", "--user", "scripted", "--no-html", "-o", dir]);
      const out = path.join(dir, "new", "report.html");
      const { stdout } = await promisify(execFile)(process.execPath, [cli, "report", path.join(dir, "results.json"), "-o", out]);
      expect(stdout.trim()).toBe(out);
      expect(existsSync(out)).toBe(true);
    });

    it("report -o names a folder, as run -o does, and the report goes in it as report.html", async () => {
      const dir = tmp();
      await promisify(execFile)(process.execPath, [cli, "run", "examples/freight", "-t", "book-at-posted-rate", "--agent", "scripted:careful", "--user", "scripted", "--no-html", "-o", dir]);
      const folder = path.join(dir, "rerender");
      const { stdout } = await promisify(execFile)(process.execPath, [cli, "report", path.join(dir, "results.json"), "-o", folder]);
      expect(stdout.trim()).toBe(path.join(folder, "report.html"));
      expect(existsSync(path.join(folder, "report.html"))).toBe(true);
      const { stdout: byDefault } = await promisify(execFile)(process.execPath, [cli, "report", path.join(dir, "results.json")]);
      expect(byDefault.trim()).toBe(path.join(dir, "report.html"));
    });

    it("a directory where a file is expected says so, and points at the results.json inside it", async () => {
      const run = tmp();
      expect((await fail(["report", run])).stderr.trim()).toBe(`report: ${run} is a directory, not a file`);
      writeFileSync(path.join(run, "results.json"), "{}");
      expect((await fail(["report", run])).stderr.trim()).toBe(`report: ${run} is a directory, not a file: did you mean ${path.join(run, "results.json")}?`);
      const spec = tmp();
      mkdirSync(path.join(spec, "api.yaml"));
      expect((await fail(["init", "--openapi", path.join(spec, "api.yaml"), "-o", path.join(tmp(), "out")])).stderr.trim()).toBe(`--openapi: ${path.join(spec, "api.yaml")} is a directory, not a file`);
    });
  });

  describe("an output folder it can't use says so, naming -o and the path, before anything is spent", () => {
    const asRoot = process.getuid?.() === 0;
    const tmp = () => realpathSync(mkdtempSync(path.join(tmpdir(), "sandtable-out-")));
    const FOLDER = "Pass a folder for results.json and report.html.";
    const ELSEWHERE = "Pass -o <dir> to write somewhere else.";
    // No key and nothing listening: a model call, if one slipped through, fails instead of costing money.
    const env = { ...process.env, ANTHROPIC_API_KEY: "", ANTHROPIC_BASE_URL: "http://127.0.0.1:9" };
    const sandtable = (args: string[], cwd?: string) =>
      promisify(execFile)(process.execPath, [cli, ...args], { env, ...(cwd ? { cwd } : {}) }).then(
        ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
        (e: { code: number; stdout: string; stderr: string }) => e,
      );
    /** A file to name by mistake. */
    const aFile = () => {
      const file = path.join(tmp(), "afile");
      writeFileSync(file, "");
      return file;
    };
    /** A folder that can't be written to, for the length of `use`. */
    async function readOnly(use: (dir: string) => Promise<void>) {
      const dir = tmp();
      chmodSync(dir, 0o555);
      try {
        await use(dir);
      } finally {
        chmodSync(dir, 0o755);
      }
    }
    const example = path.resolve("examples/freight");

    describe("run", () => {
      /** A module agent that notes whether `out` exists when its first trial starts. */
      function markingAgent(out: string) {
        const dir = tmp();
        const mark = path.join(dir, "trial-started");
        const agent = path.join(dir, "marks.mjs");
        writeFileSync(agent, `import { existsSync, writeFileSync } from "node:fs";
export default { name: "marks", createSession: async () => { writeFileSync(${JSON.stringify(mark)}, String(existsSync(${JSON.stringify(out)}))); return { reply: async () => "Goodbye." }; } };\n`);
        return { agent, mark, args: ["run", example, "--agent", agent, "--user", "scripted", "-t", "book-at-posted-rate", "-o", out] };
      }

      it("stops before the first trial at a file, with exit 2", async () => {
        const file = aFile();
        const { args, mark } = markingAgent(file);
        const r = await sandtable(args);
        expect(r.code).toBe(2);
        expect(r.stderr.trim()).toBe(`-o: ${file} is a file, not a folder. ${FOLDER}`);
        expect(r.stdout).toBe("");
        expect(existsSync(mark)).toBe(false);
      });

      it("stops before the first trial at a path under a file", async () => {
        const file = aFile();
        const under = path.join(file, "sub", "deeper");
        const { args, mark } = markingAgent(under);
        const r = await sandtable(args);
        expect(r.code).toBe(2);
        expect(r.stderr.trim()).toBe(`-o: ${under} is under ${file}, which is a file, not a folder. ${FOLDER}`);
        expect(r.stdout).toBe("");
        expect(existsSync(mark)).toBe(false);
      });

      it.skipIf(asRoot)("stops before the first trial at a folder it can't create or write", async () => {
        await readOnly(async (ro) => {
          const create = markingAgent(path.join(ro, "out"));
          const created = await sandtable(create.args);
          expect(created.code).toBe(2);
          expect(created.stderr.trim()).toBe(`-o: can't create ${path.join(ro, "out")}: permission denied`);
          expect(created.stdout).toBe("");
          expect(existsSync(create.mark)).toBe(false);

          const write = markingAgent(ro);
          const written = await sandtable(write.args);
          expect(written.code).toBe(2);
          expect(written.stderr.trim()).toBe(`-o: can't write to ${ro}: permission denied`);
          expect(existsSync(write.mark)).toBe(false);
        });
      });

      it("creates the folder before the first trial, and leaves only what it writes there", async () => {
        const out = path.join(tmp(), "new", "run");
        const { args, mark } = markingAgent(out);
        await sandtable(args);
        expect(readFileSync(mark, "utf8")).toBe("true");
        expect(readdirSync(out).sort()).toEqual(["report.html", "results.json"]);
      });

      it("says the same of the default folder, and that -o writes elsewhere", async () => {
        const cwd = tmp();
        writeFileSync(path.join(cwd, ".sandtable"), "");
        const r = await sandtable(["run", example, "--agent", "scripted:careful", "--user", "scripted", "-t", "book-at-posted-rate"], cwd);
        expect(r.code).toBe(2);
        const dot = path.join(cwd, ".sandtable");
        expect(r.stderr.trim()).toMatch(new RegExp(`^run: ${dot}/runs/\\S+-freight-carrier-sales is under ${dot}, which is a file, not a folder\\. Pass -o <dir> to write somewhere else\\.$`));
        expect(r.stdout).toBe("");
      });

      it.skipIf(asRoot)("creates nothing in a folder it can't write, and names -o for one the user didn't choose", async () => {
        await readOnly(async (cwd) => {
          const r = await sandtable(["run", example, "--agent", "scripted:careful", "--user", "scripted", "-t", "book-at-posted-rate"], cwd);
          expect(r.code).toBe(2);
          expect(r.stderr.trim()).toMatch(new RegExp(`^run: can't create ${cwd}/\\.sandtable/runs/\\S+: permission denied\\. Pass -o <dir> to write somewhere else\\.$`));
          expect(readdirSync(cwd)).toEqual([]);
        });
      });
    });

    describe("a command that reads a stored run", () => {
      let results: string;
      let models: string;
      beforeAll(async () => {
        const dir = tmp();
        await sandtable(["run", example, "--agent", "scripted:careful", "--user", "scripted", "-t", "book-at-posted-rate", "--no-html", "-o", dir]);
        results = path.join(dir, "results.json");
        models = path.join(dir, "models.yaml");
        writeFileSync(models, 'models:\n  - { label: Careful rules, agent: "scripted:careful" }\n');
      });
      const REPORT = "Pass a folder for the report, or a path ending in .html.";
      const BOARD = "Pass a folder for the board and each model's results.";
      const commands: [string, (out: string) => string[], string][] = [
        ["regrade", (out) => ["regrade", results, "-d", example, "-o", out], FOLDER],
        ["compare", (out) => ["compare", results, results, "-o", out], FOLDER],
        ["report", (out) => ["report", results, "-o", out], REPORT],
        ["judge", (out) => ["judge", results, "-d", example, "-o", out], FOLDER],
        ["leaderboard", (out) => ["leaderboard", example, "-m", models, "-u", "scripted", "-k", "1", "-t", "no-mc-number", "-o", out], BOARD],
      ];
      for (const [name, args, pass] of commands) {
        it(`${name} -o names a file or a path under one, instead of Node's raw error`, async () => {
          const file = aFile();
          const r = await sandtable(args(file));
          expect(r.code).toBe(2);
          expect(r.stderr.trim()).toBe(`-o: ${file} is a file, not a folder. ${pass}`);
          expect(r.stdout).not.toContain("results:");
          const under = path.join(file, "sub");
          const below = await sandtable(args(under));
          expect(below.code).toBe(2);
          expect(below.stderr.trim()).toBe(`-o: ${under} is under ${file}, which is a file, not a folder. ${pass}`);
        });
      }

      it("regrade and compare print nothing before saying so", async () => {
        for (const [, args] of commands.slice(0, 2)) expect((await sandtable(args!(aFile()))).stdout).toBe("");
      });

      it.skipIf(asRoot)("regrade -o names a folder it can't create or write", async () => {
        await readOnly(async (ro) => {
          const created = await sandtable(["regrade", results, "-d", example, "-o", path.join(ro, "out")]);
          expect(created.code).toBe(2);
          expect(created.stderr.trim()).toBe(`-o: can't create ${path.join(ro, "out")}: permission denied`);
          const written = await sandtable(["regrade", results, "-d", example, "-o", ro]);
          expect(written.code).toBe(2);
          expect(written.stderr.trim()).toBe(`-o: can't write to ${ro}: permission denied`);
        });
      });

      it("report -o with a file above its .html says the same", async () => {
        const file = aFile();
        const r = await sandtable(["report", results, "-o", path.join(file, "x.html")]);
        expect(r.code).toBe(2);
        expect(r.stderr.trim()).toBe(`-o: ${file} is a file, not a folder. ${REPORT}`);
      });

      it.skipIf(asRoot)("regrade, report and judge without -o say what to do about the results' own folder", async () => {
        await readOnly(async (ro) => {
          const copy = path.join(ro, "results.json");
          chmodSync(ro, 0o755);
          writeFileSync(copy, readFileSync(results));
          chmodSync(ro, 0o555);
          for (const args of [["regrade", copy, "-d", example], ["report", copy], ["judge", copy, "-d", example]]) {
            const r = await sandtable(args);
            expect(r.code, args[0]).toBe(2);
            expect(r.stderr.trim(), args[0]).toBe(`${args[0]}: can't write to ${ro}: permission denied. ${ELSEWHERE}`);
          }
        });
      });

      it("judge -o stops before its first paid call, and --dry-run still writes nothing", async () => {
        const file = aFile();
        const r = await sandtable(["judge", results, "-d", example, "-o", file]);
        expect(r.stderr).not.toContain("judge stopped");
        const out = path.join(tmp(), "new");
        const dry = await sandtable(["judge", results, "-d", example, "-o", out, "--dry-run"]);
        expect(dry.code, dry.stderr).toBe(0);
        expect(existsSync(out)).toBe(false);
      });

      it("leaderboard -o no longer sends you to a model's folder", async () => {
        const file = aFile();
        const r = await sandtable(["leaderboard", example, "-m", models, "-u", "scripted", "-k", "1", "-t", "no-mc-number", "-o", file]);
        expect(r.stderr).not.toContain("stored files");
        expect(r.stderr).not.toContain("model's folder");
        expect(r.stdout).toBe("");
      });
    });

    it("serve stops before it listens: each conversation's grade would have nowhere to go", async () => {
      const file = aFile();
      const named = await sandtable(["serve", example, "--port", "0", "-o", file]);
      expect(named.code).toBe(2);
      expect(named.stderr.trim()).toBe(`-o: ${file} is a file, not a folder. ${FOLDER}`);
      expect(named.stdout).toBe("");
      const under = path.join(file, "sub");
      expect((await sandtable(["serve", example, "--port", "0", "-o", under])).stderr.trim()).toBe(`-o: ${under} is under ${file}, which is a file, not a folder. ${FOLDER}`);
      const cwd = tmp();
      const dot = path.join(cwd, ".sandtable");
      writeFileSync(dot, "");
      const chosen = await sandtable(["serve", example, "--port", "0"], cwd);
      expect(chosen.code).toBe(2);
      expect(chosen.stderr.trim()).toMatch(new RegExp(`^serve: ${dot}/runs/\\S+-serve is under ${dot}, which is a file, not a folder\\. Pass -o <dir> to write somewhere else\\.$`));
    });

    it.skipIf(asRoot)("serve -o names a folder it can't write", async () => {
      await readOnly(async (ro) => {
        const r = await sandtable(["serve", example, "--port", "0", "-o", ro]);
        expect(r.code).toBe(2);
        expect(r.stderr.trim()).toBe(`-o: can't write to ${ro}: permission denied`);
      });
    });

    it("demo stops before its first trial when it can't write under .sandtable/runs/", async () => {
      const cwd = tmp();
      const dot = path.join(cwd, ".sandtable");
      writeFileSync(dot, "");
      const r = await sandtable(["demo", "--no-open"], cwd);
      expect(r.code).toBe(2);
      expect(r.stderr.trim()).toMatch(new RegExp(`^demo: ${dot}/runs/\\S+-demo-naive is under ${dot}, which is a file, not a folder\\. Run it from a folder you can write to\\.$`));
      expect(r.stdout).not.toContain("pass^1");
    });
  });

  it("report names a results.json that is not valid JSON", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sandtable-report-"));
    writeFileSync(path.join(dir, "results.json"), '{"domain": "freight-carrier-sales", "tasks": [');
    const { code, stderr } = await fail(["report", path.join(dir, "results.json")]);
    expect(code).toBe(2);
    expect(stderr).toContain(`${path.join(dir, "results.json")} is not valid JSON: `);
  });
});
