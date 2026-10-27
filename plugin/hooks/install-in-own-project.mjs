#!/usr/bin/env node
// A PreToolUse hook for Bash: an install of sandtable-ai with npm, pnpm or yarn runs only in a folder that is its own
// project. All three install into the nearest folder above that has a package.json, which can be another project or the
// engineer's home folder (#401), so in a folder without one the agent runs `npm init -y` (or `pnpm init`, `yarn init -y`)
// first. The drafting and results skills ask for it; this holds the agent to it on any model, even when no skill
// loaded. Anything it can't read, it lets through.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** The shell commands in one Bash call, in order, split where one ends and another can start. */
function segments(command) {
  return command.split(/&&|\|\||[;|\n]/).map((s) => s.trim());
}

/** yarn's `--cwd <folder>`, the folder quoted or a single word. */
const CWD_OPT = String.raw`--cwd(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)`;
/**
 * Each package manager's install command, the command that makes a folder its own project, and the option that
 * installs into a folder of the engineer's choice. yarn's `--cwd` runs it as if in that folder, parent lookup included,
 * so the hook checks the folder it names.
 */
const MANAGERS = {
  npm: { install: /^npm\s+(?:install|i|add|isntall)\b/, init: "npm init -y", into: "--prefix" },
  pnpm: { install: /^pnpm\s+(?:add|install|i)\b/, init: "pnpm init", into: "--dir" },
  yarn: { install: new RegExp(String.raw`^yarn(?:\s+${CWD_OPT})?\s+add\b`), init: "yarn init -y", into: "--cwd" },
};
const ENV = /^(?:\S+=\S*\s+)*/;
const SANDTABLE = /(?:^|\s)sandtable-ai(?:@\S*)?(?=\s|$)/;
// Global installs, and npm's --prefix (-C) and pnpm's --dir (-C), which install into the folder they name, creating its
// package.json if need be.
const ELSEWHERE = /(?:^|\s)(?:-g|--global|--location[= ]global|(?:--prefix|--dir|-C)(?:[= ]\S+)?)(?=\s|$)/;
const INIT = new RegExp(String.raw`^(?:npm|pnpm|yarn(?:\s+${CWD_OPT})?)\s+init\b`);
const CWD = /(?:^|\s)--cwd(?:=|\s+)("[^"]*"|'[^']*'|\S+)/;
const CD = /^cd(?:\s+(.+))?$/;

/** The folder a `cd` argument names, from `dir`; undefined for one it can't follow, such as `cd -` or `cd $X`. */
function cdTarget(arg, dir) {
  if (arg === undefined) return undefined;
  const target = arg.trim().replace(/^(["'])(.*)\1$/, "$2");
  if (!target || /[$`*?]|^-/.test(target)) return undefined;
  if (target === "~" || target.startsWith("~/")) return undefined;
  return path.resolve(dir, target);
}

/**
 * Why this Bash command must not run, or undefined when it may: it installs sandtable-ai into a folder that has no
 * package.json, and no earlier command in it runs `npm init`, `pnpm init` or `yarn init` there. A `cd` the hook can't
 * follow ends the check; a yarn `--cwd` it can't follow skips that install.
 */
function denial(command, cwd) {
  let dir = cwd;
  const initialized = new Set();
  for (const segment of segments(command)) {
    const cd = CD.exec(segment);
    if (cd) {
      dir = cdTarget(cd[1], dir);
      if (dir === undefined) return undefined;
      continue;
    }
    const run = segment.replace(ENV, "");
    const cwdArg = /^yarn\b/.test(run) ? CWD.exec(run)?.[1] : undefined;
    const target = cwdArg === undefined ? dir : cdTarget(cwdArg, dir);
    if (INIT.test(run)) {
      if (target !== undefined) initialized.add(target);
      continue;
    }
    const manager = Object.keys(MANAGERS).find((m) => MANAGERS[m].install.test(run));
    if (!manager || !SANDTABLE.test(run) || ELSEWHERE.test(run) || target === undefined) continue;
    if (initialized.has(target) || existsSync(path.join(target, "package.json"))) continue;
    const { init, into } = MANAGERS[manager];
    const first = cwdArg === undefined ? init : init.replace(/^yarn/, `yarn --cwd ${cwdArg}`);
    return `sandtable plugin: ${target} has no package.json, so ${manager} would install sandtable-ai into the nearest folder above it that has one, which may be another project or the engineer's home folder. Run \`${init}\` in ${target} first (as \`${first} && ${segment}\`), then tell the engineer which package.json you changed. If the engineer wants sandtable in a project above it, install there with \`${into} <that folder>\` instead.`;
  }
  return undefined;
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const command = input?.tool_input?.command;
  if (input?.tool_name !== "Bash" || typeof command !== "string" || typeof input.cwd !== "string" || !/\bsandtable-ai\b/.test(command)) return;
  const reason = denial(command, input.cwd);
  if (!reason) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
}

main();
