#!/usr/bin/env node
// A PreToolUse hook for Bash: an install of sandtable-ai with npm, pnpm or yarn runs only in a folder that is its own
// project. All three install into the nearest folder above that has a package.json, which can be another project or the
// engineer's home folder (#401), so in a folder without one the agent runs `npm init -y` first, whichever manager installs
// (#432). The drafting and results skills ask for it; this holds the agent to it on any model, even when no skill
// loaded. It also stops the unrelated npm package named `sandtable` from being installed or run in its place by npx,
// npm exec, pnpm dlx, yarn dlx or bunx (#441, #456): sandtable's package is sandtable-ai. Anything it can't read, it
// lets through.

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
/**
 * The commands that run a package's bin, fetching the package when it isn't installed: npx and npm's names for it, pnpm
 * dlx, yarn dlx and bunx, by their command and, for a package manager's, its subcommand. `values` are the runner's
 * options that take a value (`-p` and `--package` name a package), and `noFetch` the options that make it run only what
 * is installed: npx's `--no-install` is npm exec's `--no`, which npm exec itself doesn't take. `local` is whether it
 * runs an installed `sandtable` bin, such as sandtable-ai's, instead of fetching: npx and bunx look in node_modules
 * first, while pnpm dlx and yarn dlx always fetch. `named` is how the runner's fix names sandtable-ai: as the command,
 * or with `-p` before the `sandtable` bin for the runners whose docs say to name a package whose bin has another name
 * that way.
 */
const NPM_VALUES = ["-p", "--package", "-c", "--call", "--cache", "--userconfig", "--registry", "-w", "--workspace"];
const NO = ["--no", "--no=true", "--yes=false"];
const RUNNERS = [
  { command: "npx", values: NPM_VALUES, noFetch: ["--no-install", ...NO], local: true, named: "command" },
  { command: "npm", sub: /^(?:exec|x)$/, values: NPM_VALUES, noFetch: NO, local: true, named: "command" },
  { command: "pnpm", sub: /^dlx$/, values: ["--package", "--allow-build", "--reporter"], noFetch: [], local: false, named: "command" },
  { command: "yarn", sub: /^dlx$/, values: ["-p", "--package"], noFetch: [], local: false, named: "package" },
  { command: "bunx", values: ["-p", "--package"], noFetch: ["--no-install"], local: true, named: "package" },
  { command: "bun", sub: /^x$/, values: ["-p", "--package"], noFetch: ["--no-install"], local: true, named: "package" },
];
/** A package manager's own options that take a value, which can come before its subcommand: `pnpm -C web dlx …`. */
const MANAGER_VALUES = { npm: ["-C", "--prefix", "-w", "--workspace", "--userconfig", "--cache", "--registry"], pnpm: ["-C", "--dir", "--prefix", "-F", "--filter", "--reporter"], yarn: ["--cwd"], bun: ["--cwd", "-c", "--config"] };
/** The unrelated package's name as a whole word, with any version. */
const WRONG_NAME = /^sandtable(?:@\S*)?$/;
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
 * What to run instead of a runner's `… sandtable …`, or undefined when it may run: it runs the package `sandtable`,
 * named with `-p` or as its command, and would fetch the unrelated package of that name. A bare `sandtable` command
 * runs an installed sandtable-ai's bin for the runners that look for one (npx, bunx), when it is installed where they
 * look; with a version, `sandtable@1.2.0`, it names the package `sandtable` whatever is installed.
 */
function runnerFix(segment, run, dir) {
  const words = run.split(/\s+/);
  // The manager's options before its subcommand, each with its value when it takes one.
  let at = 1;
  while (at < words.length && words[at].startsWith("-")) at += !words[at].includes("=") && (MANAGER_VALUES[words[0]] ?? []).includes(words[at]) ? 2 : 1;
  const runner = RUNNERS.find((r) => r.command === words[0] && (!r.sub || r.sub.test(words[at] ?? "")));
  if (!runner) return undefined;
  const packages = [];
  let i = runner.sub ? at + 1 : 1;
  for (; i < words.length && words[i].startsWith("-"); i++) {
    if (words[i] === "--") {
      i++;
      break;
    }
    const [name, value] = words[i].split("=", 2);
    // The runner then runs only what is installed, and fetches nothing. `--no=false` is `--yes`.
    if (runner.noFetch.includes(words[i])) return undefined;
    if (!runner.values.includes(name)) continue;
    const v = value ?? words[++i];
    if (name === "-p" || name === "--package") packages.push(v ?? "");
  }
  const cmd = words[i];
  const swap = (word, to) => segment.replace(new RegExp(String.raw`(\s|=)${word.replace(/[.*+?^$()|[\]\\]/g, "\\$&")}(?=\s|$)`), `$1${to}`);
  const wrong = packages.find((p) => WRONG_NAME.test(p));
  // With sandtable-ai named too, the fix leaves the wrong package out rather than naming sandtable-ai twice.
  if (wrong && packages.some((p) => /^sandtable-ai(?:@\S*)?$/.test(p))) {
    return segment.replace(new RegExp(String.raw`\s(?:-p|--package)(?:=|\s+)${wrong.replace(/[.*+?^$()|[\]\\]/g, "\\$&")}(?=\s|$)`), "");
  }
  if (wrong) return swap(wrong, `sandtable-ai${wrong.slice("sandtable".length)}`);
  if (packages.length || cmd === undefined || !WRONG_NAME.test(cmd)) return undefined;
  if (runner.local && cmd === "sandtable" && (dir === undefined || installedAbove(dir))) return undefined;
  const version = cmd.slice("sandtable".length);
  return swap(cmd, runner.named === "command" ? `sandtable-ai${version}` : `-p sandtable-ai${version} sandtable`);
}

const WRONG_PACKAGE = "sandtable plugin: `sandtable` on npm is an unrelated package. sandtable's package is `sandtable-ai`";

/**
 * Why this Bash command must not run, or undefined when it may:
 * - it installs the npm package `sandtable`, or runs it with npx, npm exec, pnpm dlx, yarn dlx or bunx, instead of
 *   sandtable-ai, anywhere in the command; or
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
    const fixed = runnerFix(segment, run, at);
    if (fixed) return `${WRONG_PACKAGE}: run \`${fixed}\` instead, or install it in the project first.`;
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
