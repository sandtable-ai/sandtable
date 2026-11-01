import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The plugin's install hook (#412, after #401): `npm install` of sandtable-ai runs only in a folder that is its own npm
// project, so npm never installs into a parent project. Each test feeds the hook a Bash call and its working folder.

const hook = path.resolve("plugin/hooks/install-in-own-project.mjs");
// A parent project, and inside it a bare engagement folder with only the customer's documents, as in #401.
const parent = mkdtempSync(path.join(os.tmpdir(), "sandtable-install-"));
writeFileSync(path.join(parent, "package.json"), JSON.stringify({ name: "someone-elses-project" }));
const bare = path.join(parent, "engagement");
mkdirSync(path.join(bare, "customer-docs"), { recursive: true });
// A bare folder whose name has a space, for a quoted yarn --cwd.
const spaced = path.join(parent, "my dir");
mkdirSync(spaced);
const own = path.join(parent, "own");
mkdirSync(own);
writeFileSync(path.join(own, "package.json"), JSON.stringify({ name: "own" }));

const INSTALL = "npm install --save-dev sandtable-ai @anthropic-ai/bedrock-sdk @aws-sdk/credential-providers";

/** The hook's decision on a Bash command run in `cwd`: the deny reason, or undefined. */
function decide(command: string, cwd: string, tool = "Bash"): string | undefined {
  const input = JSON.stringify({ session_id: "s", transcript_path: "/nonexistent", cwd, hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command } });
  const res = spawnSync(process.execPath, [hook], { input, encoding: "utf8" });
  expect(res.status).toBe(0);
  if (!res.stdout.trim()) return undefined;
  const out = JSON.parse(res.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  return out.hookSpecificOutput.permissionDecisionReason;
}

describe("the plugin's install-in-own-project hook", () => {
  it("holds the 1.0.0 session's install in a bare folder, and says to run npm init -y there first", () => {
    const reason = decide(INSTALL, bare);
    expect(reason).toContain(`${bare} has no package.json`);
    expect(reason).toContain("Run `npm init -y` in");
    // An engineer who wants it in the parent project gets a way to say so.
    expect(reason).toContain("install there with `--prefix <that folder>` instead");
    expect(decide("npm i -D sandtable-ai", bare)).toBeDefined();
    expect(decide("npm add sandtable-ai@1.0.1", bare)).toBeDefined();
  });

  it("lets the install run in a folder with its own package.json, or after npm init in the same command", () => {
    expect(decide(INSTALL, own)).toBeUndefined();
    expect(decide(`npm init -y >/dev/null && ${INSTALL} && cat package.json`, bare)).toBeUndefined();
  });

  it("follows a cd in the command, both ways", () => {
    expect(decide(`cd engagement && ${INSTALL}`, parent)).toContain(`${bare} has no package.json`);
    expect(decide(`cd own && ${INSTALL}`, parent)).toBeUndefined();
    expect(decide(`cd "${bare}" && npm init -y && ${INSTALL}`, parent)).toBeUndefined();
    // A cd it can't follow ends the check rather than guessing.
    expect(decide(`cd $DIR && ${INSTALL}`, parent)).toBeUndefined();
  });

  it("holds pnpm and yarn installs in a bare folder too, says npm init -y for them as well, and names their own target option", () => {
    // Both add the package to the nearest package.json above, as npm does: pnpm add and pnpm install <pkg>, yarn add.
    for (const command of ["pnpm add -D sandtable-ai", "pnpm install sandtable-ai", "pnpm i sandtable-ai@1.1.2"]) {
      const reason = decide(command, bare);
      expect(reason).toContain(`${bare} has no package.json, so pnpm would install sandtable-ai`);
      expect(reason).toContain(`Run \`npm init -y\` in ${bare} first (as \`npm init -y && ${command}\`)`);
      // pnpm 11's own init writes a devEngines field that makes npx refuse to run (#432).
      expect(reason).toContain("`pnpm init` adds a `devEngines` field that makes `npx sandtable-ai` refuse to run");
      expect(reason).toContain("install there with `--dir <that folder>` instead");
    }
    const reason = decide("yarn add --dev sandtable-ai", bare);
    expect(reason).toContain("so yarn would install sandtable-ai");
    expect(reason).toContain(`Run \`npm init -y\` in ${bare} first (as \`npm init -y && yarn add --dev sandtable-ai\`)`);
    expect(reason).toContain("Use `npm init -y` even with yarn");
    expect(reason).toContain("install there with `--cwd <that folder>` instead");
    expect(decide("pnpm add -D sandtable-ai", own)).toBeUndefined();
    expect(decide("pnpm init && pnpm add -D sandtable-ai", bare)).toBeUndefined();
    expect(decide("yarn init -y && yarn add --dev sandtable-ai", bare)).toBeUndefined();
    // One manager's init makes the folder a project for another's install.
    expect(decide("npm init -y && pnpm add -D sandtable-ai", bare)).toBeUndefined();
  });

  it("checks the folder yarn's --cwd names, which looks for a package.json above it as a cd would", () => {
    const reason = decide("yarn --cwd engagement add --dev sandtable-ai", parent);
    expect(reason).toContain(`${bare} has no package.json, so yarn would install`);
    expect(reason).toContain(`(as \`cd ${bare} && npm init -y && yarn add --dev sandtable-ai\`)`);
    expect(decide("yarn add --dev sandtable-ai --cwd=engagement", parent)).toContain(`${bare} has no package.json`);
    expect(decide("yarn --cwd engagement init -y && yarn --cwd engagement add sandtable-ai", parent)).toBeUndefined();
    expect(decide("yarn --cwd own add sandtable-ai", parent)).toBeUndefined();
    expect(decide("yarn --cwd .. add sandtable-ai", bare)).toBeUndefined();
    expect(decide("yarn --cwd $DIR add sandtable-ai", parent)).toBeUndefined();
    // A quoted folder with a space, before or after add.
    expect(decide('yarn add sandtable-ai --cwd "my dir"', parent)).toContain(`${spaced} has no package.json, so yarn would install sandtable-ai`);
    expect(decide('yarn add sandtable-ai --cwd "my dir"', parent)).toContain(`(as \`cd '${spaced}' && npm init -y && yarn add sandtable-ai\`)`);
    expect(decide("yarn --cwd 'my dir' add sandtable-ai", parent)).toContain(`${spaced} has no package.json`);
    expect(decide('yarn --cwd "my dir" init -y && yarn --cwd "my dir" add sandtable-ai', parent)).toBeUndefined();
  });

  it("suggests a command that, run from the same folder, it lets through and that installs into the folder it checked", () => {
    const cases: [string, string][] = [
      [INSTALL, bare],
      ["npm i -D sandtable-ai", bare],
      [`cd engagement && ${INSTALL}`, parent],
      ["pnpm add -D sandtable-ai", bare],
      ["pnpm install sandtable-ai", bare],
      ["yarn add --dev sandtable-ai", bare],
      ["yarn --cwd engagement add --dev sandtable-ai", parent],
      ["yarn add sandtable-ai --cwd=engagement", parent],
      ['yarn add sandtable-ai --cwd "my dir"', parent],
      ["yarn --cwd 'my dir' add sandtable-ai", parent],
      // After a cd in the same command, the suggestion moves there first: without it, the install would run in the parent.
      [`cd engagement && pnpm add -D sandtable-ai`, parent],
      [`cd "my dir" && yarn add sandtable-ai`, parent],
      [`pnpm init && cd engagement && pnpm add -D sandtable-ai`, parent],
      [`cd ${bare} && npm install sandtable-ai`, own],
    ];
    for (const [command, cwd] of cases) {
      const reason = decide(command, cwd)!;
      const target = reason.match(/^sandtable plugin: (.+?) has no package\.json/)![1];
      const fix = reason.match(/\(as `([^`]+)`\)/)?.[1];
      expect(fix, command).toBeDefined();
      expect(decide(fix!, cwd), fix).toBeUndefined();
      expect(fix).not.toMatch(/pnpm init|yarn init/);
      // Without its npm init, the suggestion is held for the same folder: that's where it installs.
      expect(decide(fix!.replace("npm init -y && ", ""), cwd), fix).toContain(`${target} has no package.json`);
    }
  });

  it("leaves other commands alone: global, --prefix and --dir installs, other packages, npx, other tools", () => {
    expect(decide("npm install -g sandtable-ai", bare)).toBeUndefined();
    expect(decide("npm install --prefix ./tools sandtable-ai", bare)).toBeUndefined();
    expect(decide("npm install -C ./tools sandtable-ai", bare)).toBeUndefined();
    // pnpm's --dir creates the package.json in the folder it names.
    expect(decide("pnpm add --dir ./engagement sandtable-ai", parent)).toBeUndefined();
    expect(decide("pnpm add -g sandtable-ai", bare)).toBeUndefined();
    expect(decide("yarn global add sandtable-ai", bare)).toBeUndefined();
    expect(decide("pnpm dlx sandtable-ai validate ./sandtable", bare)).toBeUndefined();
    expect(decide("npm install --save-dev typescript", bare)).toBeUndefined();
    expect(decide("npx sandtable-ai validate ./sandtable", bare)).toBeUndefined();
    expect(decide("npm view sandtable-ai version", bare)).toBeUndefined();
    expect(decide(INSTALL, bare, "Read")).toBeUndefined();
  });

  it("stops the unrelated npm package named sandtable from being installed or run by npx, and names sandtable-ai (#441)", () => {
    const wrong = "sandtable plugin: `sandtable` on npm is an unrelated package. sandtable's package is `sandtable-ai`";
    // In a project of its own too: the package is wrong wherever it goes.
    for (const cmd of ["pnpm add -D sandtable", "npm install sandtable", "npm i sandtable@1.0.2", "yarn add sandtable", "npm install -g sandtable", "cd engagement && pnpm add sandtable"]) {
      expect(decide(cmd, own), cmd).toContain(wrong);
    }
    expect(decide("pnpm add -D sandtable", own)).toContain("install it as `pnpm add -D sandtable-ai` instead, and run it as `npx sandtable-ai <command>`.");
    expect(decide("npm i sandtable@1.0.2", own)).toContain("install it as `npm i sandtable-ai@1.0.2` instead");
    expect(decide("npm i sandtable-ai sandtable", own)).toContain("install it as `npm i sandtable-ai` instead");
    // npx would fetch the unrelated package when no sandtable-ai is installed where it looks.
    expect(decide("npx sandtable init --sop sop.md", bare)).toContain("run `npx sandtable-ai init --sop sop.md` instead, or install it in the project first.");
    expect(decide("npx -y sandtable@latest demo", bare)).toContain("run `npx -y sandtable-ai@latest demo` instead");
    const installed = path.join(parent, "installed");
    mkdirSync(path.join(installed, "node_modules", "sandtable-ai"), { recursive: true });
    mkdirSync(path.join(installed, "sub"));
    expect(decide("npx sandtable demo", installed)).toBeUndefined();
    expect(decide("npx sandtable demo", path.join(installed, "sub"))).toBeUndefined();
    expect(decide("cd installed && npx sandtable demo", parent)).toBeUndefined();
    // npx that may not fetch runs only what is installed.
    for (const cmd of ["npx --no-install sandtable demo", "npx --no sandtable demo", "npx --yes=false sandtable demo"]) expect(decide(cmd, bare), cmd).toBeUndefined();
    // The right package, the -p form, and commands that only mention the name.
    for (const cmd of ["npx -p sandtable-ai -p @anthropic-ai/bedrock-sdk sandtable init --sop x", "npx --package=sandtable-ai sandtable demo", "npx sandtable-ai demo", "npm view sandtable version", "grep -r sandtable notes.md", "npm uninstall sandtable", "npm install @acme/sandtable"]) {
      expect(decide(cmd, own), cmd).toBeUndefined();
    }
  });

  it("stops npm exec, -p sandtable, pnpm dlx, yarn dlx and bunx from running the unrelated package too, and suggests a form it lets through (#456)", () => {
    const installed = path.join(parent, "installed");
    mkdirSync(path.join(installed, "node_modules", "sandtable-ai"), { recursive: true });
    const cases: [string, string][] = [
      ["npm exec sandtable -- demo", "npm exec sandtable-ai -- demo"],
      ["npm exec -- sandtable demo", "npm exec -- sandtable-ai demo"],
      ["npm x --yes sandtable demo", "npm x --yes sandtable-ai demo"],
      ["npx -p sandtable sandtable demo", "npx -p sandtable-ai sandtable demo"],
      ["npx --package=sandtable@1.2.0 sandtable demo", "npx --package=sandtable-ai@1.2.0 sandtable demo"],
      ["npx --no=false sandtable demo", "npx --no=false sandtable-ai demo"],
      ["pnpm dlx sandtable demo", "pnpm dlx sandtable-ai demo"],
      ["pnpm dlx --package sandtable sandtable demo", "pnpm dlx --package sandtable-ai sandtable demo"],
      ["yarn dlx sandtable demo", "yarn dlx -p sandtable-ai sandtable demo"],
      ["bunx sandtable demo", "bunx -p sandtable-ai sandtable demo"],
      ["bun x sandtable@1.2.0 demo", "bun x -p sandtable-ai@1.2.0 sandtable demo"],
      // npm exec has no --no-install of its own: npm takes it as an unknown config and fetches anyway.
      ["npm exec --no-install sandtable -- demo", "npm exec --no-install sandtable-ai -- demo"],
      // The manager's own options can come before its subcommand.
      ["pnpm -C web dlx sandtable demo", "pnpm -C web dlx sandtable-ai demo"],
      ["pnpm --silent dlx sandtable demo", "pnpm --silent dlx sandtable-ai demo"],
      ["npm -w pkg exec sandtable -- demo", "npm -w pkg exec sandtable-ai -- demo"],
      ["yarn --cwd x dlx sandtable demo", "yarn --cwd x dlx -p sandtable-ai sandtable demo"],
      // With sandtable-ai named too, the fix leaves the wrong package out.
      ["npx -p sandtable-ai -p sandtable sandtable demo", "npx -p sandtable-ai sandtable demo"],
    ];
    for (const [command, fix] of cases) {
      expect(decide(command, bare), command).toContain(`run \`${fix}\` instead, or install it in the project first.`);
      expect(decide(fix, bare), fix).toBeUndefined();
    }
    // A bare sandtable runs an installed sandtable-ai's bin where npx and bunx look for one. A version names the
    // package sandtable whatever is installed, -p sandtable names it outright, and pnpm dlx and yarn dlx always fetch.
    for (const cmd of ["npx sandtable demo", "npm exec sandtable -- demo", "bunx sandtable demo", "npx --no=false sandtable demo"]) expect(decide(cmd, installed), cmd).toBeUndefined();
    for (const cmd of ["npx sandtable@1.2.0 demo", "npx -p sandtable sandtable demo", "pnpm dlx sandtable demo", "yarn dlx sandtable demo"]) expect(decide(cmd, installed), cmd).toContain("unrelated package");
    // Runners that may not fetch, and the ones that run only what is installed.
    for (const cmd of ["npm exec --no sandtable -- demo", "npx --no=true sandtable demo", "npx --no-install sandtable demo", "bunx --no-install sandtable demo", "pnpm exec sandtable demo", "pnpm -C web exec sandtable demo", "yarn sandtable demo", "npx -p cowsay sandtable demo"]) expect(decide(cmd, bare), cmd).toBeUndefined();
  });

  it("is registered for Bash in the plugin's hooks.json, by a path inside the plugin", () => {
    const config = JSON.parse(readFileSync(path.resolve("plugin/hooks/hooks.json"), "utf8")) as { hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string; args: string[] }[] }[] } };
    const bash = config.hooks.PreToolUse.find((e) => e.matcher === "Bash")!;
    // Exec form: the path is one argument, so spaces and backslashes in the plugin's folder need no quoting.
    expect(bash.hooks).toContainEqual(expect.objectContaining({ type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/hooks/install-in-own-project.mjs"] }));
  });

  it("lets the call through when it can't read its input", () => {
    expect(spawnSync(process.execPath, [hook], { input: "not json", encoding: "utf8" }).stdout).toBe("");
    expect(spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: INSTALL } }), encoding: "utf8" }).stdout).toBe("");
  });
});
