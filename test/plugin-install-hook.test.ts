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

  it("holds pnpm and yarn installs in a bare folder too, and names their own init and target option", () => {
    // Both add the package to the nearest package.json above, as npm does: pnpm add and pnpm install <pkg>, yarn add.
    for (const command of ["pnpm add -D sandtable-ai", "pnpm install sandtable-ai", "pnpm i sandtable-ai@1.1.2"]) {
      const reason = decide(command, bare);
      expect(reason).toContain(`${bare} has no package.json, so pnpm would install sandtable-ai`);
      expect(reason).toContain(`Run \`pnpm init\` in ${bare} first (as \`pnpm init && ${command}\`)`);
      expect(reason).toContain("install there with `--dir <that folder>` instead");
    }
    const reason = decide("yarn add --dev sandtable-ai", bare);
    expect(reason).toContain("so yarn would install sandtable-ai");
    expect(reason).toContain("Run `yarn init -y` in");
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
    expect(reason).toContain("(as `yarn --cwd engagement init -y && yarn --cwd engagement add --dev sandtable-ai`)");
    expect(decide("yarn add --dev sandtable-ai --cwd=engagement", parent)).toContain(`${bare} has no package.json`);
    expect(decide("yarn --cwd engagement init -y && yarn --cwd engagement add sandtable-ai", parent)).toBeUndefined();
    expect(decide("yarn --cwd own add sandtable-ai", parent)).toBeUndefined();
    expect(decide("yarn --cwd .. add sandtable-ai", bare)).toBeUndefined();
    expect(decide("yarn --cwd $DIR add sandtable-ai", parent)).toBeUndefined();
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
