#!/usr/bin/env node
// A PreToolUse hook for Bash: `npm install` of sandtable-ai runs only in a folder that is its own npm project. npm
// installs into the nearest folder above that has a package.json, which can be another project or the engineer's home
// folder (#401), so in a folder without one the agent runs `npm init -y` first. The drafting and results skills ask for
// it; this holds the agent to it on any model, even when no skill loaded. Anything it can't read, it lets through.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** The shell commands in one Bash call, in order, split where one ends and another can start. */
function segments(command) {
  return command.split(/&&|\|\||[;|\n]/).map((s) => s.trim());
}

const INSTALL = /^(?:\S+=\S*\s+)*npm\s+(?:install|i|add|isntall)\b/;
const SANDTABLE = /(?:^|\s)sandtable-ai(?:@\S*)?(?=\s|$)/;
const ELSEWHERE = /(?:^|\s)(?:-g|--global|--location[= ]global|--prefix(?:[= ]\S+)?)(?=\s|$)/;
const INIT = /^(?:\S+=\S*\s+)*npm\s+init\b/;
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
 * package.json, and no earlier command in it runs `npm init` there. A `cd` the hook can't follow ends the check.
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
    if (INIT.test(segment)) {
      initialized.add(dir);
      continue;
    }
    if (!INSTALL.test(segment) || !SANDTABLE.test(segment) || ELSEWHERE.test(segment)) continue;
    if (initialized.has(dir) || existsSync(path.join(dir, "package.json"))) continue;
    return `sandtable plugin: ${dir} has no package.json, so npm would install sandtable-ai into the nearest folder above it that has one, which may be another project or the engineer's home folder. Run \`npm init -y\` in ${dir} first (as \`npm init -y && ${segment}\`), then tell the engineer which package.json you changed. If the engineer wants sandtable in a project above it, install there with \`--prefix <that folder>\` instead.`;
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
