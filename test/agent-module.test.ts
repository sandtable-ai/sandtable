import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { agentModuleError } from "../src/sim/resolve.ts";

// A module agent uses `export`, so Node must read it as an ES module. In a project whose package.json says
// "type": "commonjs", as `npm init` writes, a .ts or .js agent fails to load: the error says what to change.

const AGENT = 'const agent = { name: "tiny", async createSession() { return { async reply() { return "Thanks for calling."; } }; } };\nexport default agent;\n';

describe("agentModuleError", () => {
  it("says to rename a .ts agent to .mts, or set type module, when Node read it as CommonJS", () => {
    const err = agentModuleError("./agent.ts", "/p/agent.ts", new SyntaxError("Unexpected token 'export'"));
    expect(err.message).toBe(
      'could not load the agent module ./agent.ts: Unexpected token \'export\'. Node read it as CommonJS, but it uses ES module syntax: rename it to .mts, or set "type": "module" in the package.json nearest to it.',
    );
    expect(agentModuleError("./a.js", "/p/a.js", new SyntaxError("Cannot use import statement outside a module")).message).toContain("rename it to .mjs");
    // Node's message already ending a sentence gets no second period.
    expect(agentModuleError("./a.js", "/p/a.js", new SyntaxError("Cannot use import statement outside a module.")).message).toContain("outside a module. Node read it");
  });

  it("says which Node a TypeScript agent needs when Node doesn't know the .ts extension", () => {
    const old = Object.assign(new TypeError('Unknown file extension ".ts" for /p/agent.ts'), { code: "ERR_UNKNOWN_FILE_EXTENSION" });
    const msg = agentModuleError("./agent.ts", "/p/agent.ts", old).message;
    expect(msg).toContain('for /p/agent.ts. Loading a TypeScript agent needs Node 22.18 or later');
    expect(msg).toContain(`this is Node ${process.versions.node}`);
    expect(agentModuleError("./agent.mts", "/p/agent.mts", old).message).toContain("needs Node 22.18 or later");
  });

  it("adds nothing to other errors", () => {
    expect(agentModuleError("./a.mjs", "/p/a.mjs", new Error("boom")).message).toBe("could not load the agent module ./a.mjs: boom");
    // An .mjs file is always an ES module, so the CommonJS hint can't apply to it.
    expect(agentModuleError("./a.mjs", "/p/a.mjs", new SyntaxError("Unexpected token 'export'")).message).not.toContain("rename");
  });
});

describe.skipIf(!process.features.typescript)("`run --agent` with a .ts agent in a CommonJS project", () => {
  const run = (dir: string, agent: string) =>
    promisify(execFile)(process.execPath, [path.resolve("src/cli.ts"), "run", path.resolve("examples/freight"), "-t", "book-at-posted-rate", "--agent", agent, "--user", "scripted", "--no-html", "-o", path.join(dir, "out")], { cwd: dir }).then(
      (r) => ({ code: 0, stderr: r.stderr }),
      (e: { code: number; stderr: string }) => e,
    );
  const project = (type: "commonjs" | "module") => {
    const dir = mkdtempSync(path.join(tmpdir(), "sandtable-agent-module-"));
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "my-project", version: "1.0.0", type }));
    return dir;
  };

  it("fails with exit 2 and says how to fix it", async () => {
    const dir = project("commonjs");
    writeFileSync(path.join(dir, "agent.ts"), AGENT);
    const r = await run(dir, "./agent.ts");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("could not load the agent module ./agent.ts");
    expect(r.stderr).toContain('rename it to .mts, or set "type": "module"');
  });

  it("loads as .mts in the same project, or as .ts once the project is an ES module", async () => {
    const cjs = project("commonjs");
    writeFileSync(path.join(cjs, "agent.mts"), AGENT);
    // The agent books nothing, so the task fails, but with no gate set the run itself succeeds.
    expect(await run(cjs, "./agent.mts")).toMatchObject({ code: 0 });
    const esm = project("module");
    writeFileSync(path.join(esm, "agent.ts"), AGENT);
    expect(await run(esm, "./agent.ts")).toMatchObject({ code: 0 });
  });
});
