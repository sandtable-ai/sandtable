import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    expect(code).toBe(1);
    expect(stderr).toMatch(/^unknown agent "cluade": use claude, claude:<model>, .* or the path of a JS\/TS module \(there is no file at /);
  });

  it("report refuses a file that is not a results.json", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sandtable-report-"));
    writeFileSync(path.join(dir, "leaderboard.json"), JSON.stringify({ version: 1, rows: [] }));
    const { code, stderr } = await fail(["report", path.join(dir, "leaderboard.json")]);
    expect(code).toBe(1);
    expect(stderr).toContain("is not a results.json written by `sandtable run`");
    expect(stderr).toContain("it is a leaderboard's leaderboard.json: each model's results.json is in its folder");
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
        expect(code).toBe(1);
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
      expect(code).toBe(1);
      expect(stderr.trim()).toBe("--transcripts: no file or directory at nope/");
      expect(existsSync(out)).toBe(false);
    });

    it("init --transcripts names a directory with no transcript in it", async () => {
      const dir = tmp();
      writeFileSync(path.join(dir, "notes.pdf"), "");
      const { code, stderr } = await fail(["init", "--transcripts", dir, "-o", path.join(tmp(), "out")]);
      expect(code).toBe(1);
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

  it("report names a results.json that is not valid JSON", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sandtable-report-"));
    writeFileSync(path.join(dir, "results.json"), '{"domain": "freight-carrier-sales", "tasks": [');
    const { code, stderr } = await fail(["report", path.join(dir, "results.json")]);
    expect(code).toBe(1);
    expect(stderr).toContain(`${path.join(dir, "results.json")} is not valid JSON: `);
  });
});
