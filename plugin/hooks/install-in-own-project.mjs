#!/usr/bin/env node
// A PreToolUse hook for Bash: an install of sandtable-ai with npm, pnpm or yarn runs only in a folder that is its own
// project. All three install into the nearest folder above that has a package.json, which can be another project or the
// engineer's home folder (#401), so in a folder without one the agent runs `npm init -y` first, whichever manager installs
// (#432). The drafting and results skills ask for it; this holds the agent to it on any model, even when no skill
// loaded. It also stops the unrelated npm package named `sandtable` from being installed or run by npx in its place
// (#441): sandtable's package is sandtable-ai. Anything it can't read, it lets through.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** The shell commands in one Bash call, in order, split where one ends and another can start. */
function segments(command) {
  return command.split(/&&|\|\||[;|\n]/).map((s) => s.trim());
}

/** yarn's `--cwd <folder>`, the folder quoted or a single word. */
const CWD_OPT = String.raw`--cwd(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)`;
/**
 * Each package manager's install command, the option that installs into a folder of the engineer's choice, and why the
 * agent makes a folder a project with `npm init -y` even when it installs with that manager. npm comes with Node, which
 * this hook needs too. yarn's `--cwd` runs it as if in that folder, parent lookup included, so the hook checks the
 * folder it names.
 */
const MANAGERS = {
  npm: { install: /^npm\s+(?:install|i|add|isntall)\b/, into: "--prefix", why: "" },
  pnpm: { install: /^pnpm\s+(?:add|install|i)\b/, into: "--dir", why: " Use `npm init -y` even with pnpm: `pnpm init` adds a `devEngines` field that makes `npx sandtable-ai` refuse to run." },
  yarn: { install: new RegExp(String.raw`^yarn(?:\s+${CWD_OPT})?\s+add\b`), into: "--cwd", why: " Use `npm init -y` even with yarn: `yarn init -y` can write a package name that `yarn add` rejects." },
};
const ENV = /^(?:\S+=\S*\s+)*/;
const SANDTABLE = /(?:^|\s)sandtable-ai(?:@\S*)?(?=\s|$)/;
/** The unrelated npm package named `sandtable`, as an install's package word. */
const WRONG = /(^|\s)sandtable(@\S*)?(?=\s|$)/;
/** npx's options that take a value, and the ones among them that name a package. */
const NPX_VALUE = new Set(["-p", "--package", "-c", "--call", "--cache", "--userconfig", "--registry"]);
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

/** A path as one shell word: as it is when it needs no quoting, else in single quotes. */
const shellWord = (p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`);

/** Whether sandtable-ai is installed in `dir`'s project or a folder above, where npx finds its `sandtable` bin. */
function installedAbove(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (existsSync(path.join(d, "node_modules", "sandtable-ai"))) return true;
    if (path.dirname(d) === d) return false;
  }
}

/**
 * Why `npx … sandtable …` must not run, or undefined when it may: its command is `sandtable` with no `-p sandtable-ai`,
 * and no sandtable-ai is installed where npx looks, so npx would fetch and run the unrelated package named `sandtable`.
 */
function npxWrong(run, dir) {
  const words = run.split(/\s+/);
  if (words[0] !== "npx") return undefined;
  const packages = [];
  let i = 1;
  for (; i < words.length && words[i].startsWith("-"); i++) {
    const [name, value] = words[i].split("=", 2);
    // npx then runs only what is installed, and fetches nothing.
    if (name === "--no-install" || name === "--no" || words[i] === "--yes=false") return undefined;
    if (!NPX_VALUE.has(name)) continue;
    const v = value ?? words[++i];
    if (name === "-p" || name === "--package") packages.push(v ?? "");
  }
  const cmd = words[i];
  if (cmd === undefined || !/^sandtable(?:@\S*)?$/.test(cmd) || packages.length || dir === undefined || installedAbove(dir)) return undefined;
  return cmd;
}

const WRONG_PACKAGE = "sandtable plugin: `sandtable` on npm is an unrelated package. sandtable's package is `sandtable-ai`";

/**
 * Why this Bash command must not run, or undefined when it may:
 * - it installs the npm package `sandtable`, or runs it with npx, instead of sandtable-ai, anywhere in the command; or
 * - it installs sandtable-ai into a folder that has no package.json, and no earlier command in it runs `npm init`,
 *   `pnpm init` or `yarn init` there. A `cd` the hook can't follow ends this check; a yarn `--cwd` it can't follow
 *   skips that install.
 */
function denial(command, cwd) {
  let at = cwd;
  for (const segment of segments(command)) {
    const cd = CD.exec(segment);
    if (cd) {
      // A cd it can't follow leaves the folder unknown from there on.
      at = at === undefined ? undefined : cdTarget(cd[1], at);
      continue;
    }
    const run = segment.replace(ENV, "");
    const manager = Object.keys(MANAGERS).find((m) => MANAGERS[m].install.test(run));
    if (manager && WRONG.test(run)) {
      // The same install with sandtable-ai, or without the wrong package when it installs sandtable-ai already.
      const fixed = SANDTABLE.test(run) ? segment.replace(WRONG, "") : segment.replace(WRONG, "$1sandtable-ai$2");
      return `${WRONG_PACKAGE}: install it as \`${fixed}\` instead, and run it as \`npx sandtable-ai <command>\`.`;
    }
    const cmd = npxWrong(run, at);
    if (cmd) {
      const fixed = segment.replace(new RegExp(String.raw`(\s)${cmd.replace(/[.*+?^$()|[\]\\]/g, "\\$&")}(?=\s|$)`), `$1sandtable-ai${cmd.slice("sandtable".length)}`);
      return `${WRONG_PACKAGE}: run \`${fixed}\` instead, or install it in the project first.`;
    }
  }
  return projectDenial(command, cwd);
}

/** The project check of denial(): an install of sandtable-ai into a folder with no package.json. */
function projectDenial(command, cwd) {
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
    const { into, why } = MANAGERS[manager];
    // The command to run from where this one starts. npm init has no option for another folder, so when the install
    // runs elsewhere (after a cd, or with yarn's --cwd), it moves there first, and installs without --cwd.
    const install = cwdArg === undefined ? segment : segment.replace(new RegExp(String.raw`\s+${CWD_OPT}`), "");
    const fix = target === path.resolve(cwd) ? `npm init -y && ${install}` : `cd ${shellWord(target)} && npm init -y && ${install}`;
    return `sandtable plugin: ${target} has no package.json, so ${manager} would install sandtable-ai into the nearest folder above it that has one, which may be another project or the engineer's home folder. Run \`npm init -y\` in ${target} first (as \`${fix}\`), then tell the engineer which package.json you changed.${why} If the engineer wants sandtable in a project above it, install there with \`${into} <that folder>\` instead.`;
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
  if (input?.tool_name !== "Bash" || typeof command !== "string" || typeof input.cwd !== "string" || !/\bsandtable\b/.test(command)) return;
  const reason = denial(command, input.cwd);
  if (!reason) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
}

main();
