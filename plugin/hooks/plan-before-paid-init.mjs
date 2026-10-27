#!/usr/bin/env node
// A PreToolUse hook for Bash: a model-backed `sandtable init` (with --sop or --transcripts, without --dry-run) runs only
// after a dry run of it, and when it runs, the engineer sees that dry run's plan, the calls and what they cost, as a
// message from the plugin. The drafting skill asks Claude to write the plan itself, and some models skip it; this shows
// it on any model, without holding the command. Anything it can't read, it lets through: the hook only ever blocks a
// call it knows is a paid init with no dry run before it.
//
// Why it doesn't check that Claude wrote the plan: Claude Code writes a response to the transcript only after its tool
// calls have run, so when this hook runs, the transcript ends at the previous response. A plan written in the same
// response as the paid init, which is the usual way to write it, can't be seen yet. The dry run and its output always
// are, since they came in an earlier response.

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** The shell commands in one Bash call, split where one ends and another can start. */
function segments(command) {
  return command.split(/&&|\|\||[;|\n]/);
}

/** The CLI as a word: `sandtable`, `sandtable-ai` or `sandtable-ai@<version>`. */
const BIN = /\bsandtable(?:-ai)?(?:@[\w.^~-]+)?$/;
// `npm exec sandtable-ai -- init` and `npm run sandtable -- init` put a `--` before init.
const INIT = /\bsandtable(?:-ai)?(?:@[\w.^~-]+)?\s+(?:--\s+)?init\b/;
const MODEL_BACKED = /--(?:sop|transcripts)\b/;
const DRY_RUN = /--dry-run\b/;

/** A segment that runs init with a model-backed step: paid without --dry-run, free with it. */
const initKind = (segment) => (INIT.test(segment) && MODEL_BACKED.test(segment) ? (DRY_RUN.test(segment) ? "dry" : "paid") : undefined);

/** Whether a Bash command runs a model-backed init without --dry-run, alone or chained with other commands. */
function isPaidInit(command) {
  return segments(command).some((s) => initKind(s) === "paid");
}

/** Whether a Bash command is a dry run of a model-backed init and runs no paid one. */
function isDryRun(command) {
  const kinds = segments(command).map(initKind);
  return kinds.includes("dry") && !kinds.includes("paid");
}

/** A shell command's words, with quotes removed: enough to compare two `init` commands, not a full shell parser. */
function words(segment) {
  const out = [];
  for (const m of segment.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** init's options that take a value, by every name they go by. */
const VALUE_FLAGS = { "--provider": "--provider", "--region": "--region", "--aws-profile": "--aws-profile", "--openapi": "--openapi", "--sop": "--sop", "--transcripts": "--transcripts", "-o": "--out", "--out": "--out", "-m": "--model", "--model": "--model" };
/** Options that don't change what the model-backed steps call or cost: the free --openapi step, the AWS profile, --force, --dry-run. */
const IGNORED = new Set(["--openapi", "--aws-profile", "--force", "--dry-run", "-h", "--help"]);
const PATHS = new Set(["--openapi", "--sop", "--transcripts", "--out"]);
/** The environment variables that pick init's provider, region or Bedrock client, and the flag that overrides each. */
const ENV_FLAGS = { AWS_REGION: "--region", AWS_DEFAULT_REGION: "--region", SANDTABLE_PROVIDER: "--provider", SANDTABLE_BEDROCK_CLIENT: undefined };

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/** Records a `NAME=value` word in `env` when NAME is one of ENV_FLAGS. */
function assign(env, word) {
  const m = word.match(ASSIGNMENT);
  if (m && m[1] in ENV_FLAGS) env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
}

/** The folder a `cd` argument names, from `dir`; undefined for one it can't follow, such as `cd -`, `cd $X`, or a relative `cd` from an unknown folder. */
function cdTarget(arg, dir) {
  if (!arg || /[$`*?]|^-/.test(arg)) return undefined;
  if (arg === "~" || arg.startsWith("~/")) return path.join(os.homedir(), arg.slice(2));
  if (path.isAbsolute(arg)) return path.resolve(arg);
  return dir === undefined ? undefined : path.resolve(dir, arg);
}

/** A path option's file, from `dir`; undefined for a relative path from an unknown folder. */
function resolvePath(value, dir) {
  if (value === "~" || value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  if (path.isAbsolute(value)) return path.resolve(value);
  return dir === undefined ? undefined : path.resolve(dir, value);
}

/**
 * What an `init` segment runs, as a string two segments share when they make the same model calls: its options after
 * `init`, by long name, with the options that don't change the plan left out. `-o` defaults to `sandtable`, as the
 * CLI's does. Paths are resolved from `dir`, the folder the segment runs in. The environment variables in ENV_FLAGS
 * count too, from `env` (what the command set before this segment) and the segment's own `NAME=value` prefix, unless a
 * flag overrides them. Undefined when a relative path's folder is unknown: such a segment matches nothing.
 */
function initKey(segment, env = {}, dir = undefined) {
  const all = words(segment);
  const at = all.findIndex((w, i) => w === "init" && (BIN.test(all[i - 1] ?? "") || (all[i - 1] === "--" && BIN.test(all[i - 2] ?? ""))));
  const vars = { ...env };
  for (const w of all.slice(0, Math.max(at, 0))) assign(vars, w);
  const opts = { "--out": "sandtable" };
  const rest = [];
  const args = all.slice(at + 1);
  for (let i = 0; i < args.length; i++) {
    let w = args[i];
    // Redirections: `2>&1`, `>/dev/null`, `2> log` and the like end nothing here, but aren't init's.
    if (/^\d*[<>]/.test(w) || /^&>/.test(w)) {
      if (/^\d*[<>]{1,2}&?$/.test(w) || w === "&>") i++;
      continue;
    }
    let value;
    const eq = w.match(/^(--[\w-]+)=(.*)$/);
    if (eq) [w, value] = [eq[1], eq[2]];
    const name = VALUE_FLAGS[w];
    if (name) {
      value ??= args[++i];
      if (!IGNORED.has(name)) opts[name] = value;
    } else if (!IGNORED.has(w)) rest.push(w);
  }
  for (const name of PATHS) {
    if (typeof opts[name] !== "string") continue;
    opts[name] = resolvePath(opts[name], dir);
    if (opts[name] === undefined) return undefined;
  }
  for (const [name, value] of Object.entries(vars)) if (!(ENV_FLAGS[name] in opts)) opts[name] = value;
  return JSON.stringify([Object.entries(opts).sort(([a], [b]) => (a < b ? -1 : 1)), rest]);
}

/** A word that changes the shell's folder: `cd`, `pushd` or `popd`, also as `(cd` at the start of a subshell. */
const CHDIR = /^\(?(?:cd|pushd|popd)$/;

/** Whether a command changes the shell's folder anywhere in it. */
const changesDir = (command) => segments(command).some((s) => words(s).some((w) => CHDIR.test(w)));

/**
 * The keys of a command's `init` segments of one kind, in order. Each counts what the command set before it: the
 * variables it exported or assigned, and the folder it ran in, from `dir` (where the command started; undefined when
 * unknown) and each `cd` before it. A folder change it can't follow, such as `cd $X`, a subshell's `(cd`, or `pushd`,
 * makes the folder unknown from there on.
 */
function initKeys(command, kind, dir) {
  const env = {};
  const keys = [];
  for (const segment of segments(command)) {
    const all = words(segment);
    if (all[0] === "cd") dir = cdTarget(all[1], dir);
    else if (all.some((w) => CHDIR.test(w))) dir = undefined;
    // `export NAME=value`, or a bare `NAME=value` with no command, which also reaches init when NAME is exported already.
    if (all[0] === "export") all.slice(1).forEach((w) => assign(env, w));
    else if (all.length && all.every((w) => ASSIGNMENT.test(w))) all.forEach((w) => assign(env, w));
    if (initKind(segment) === kind) keys.push(initKey(segment, env, dir));
  }
  return keys;
}

/** The text of a tool result's content, a string or a list of text blocks. */
function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (typeof b?.text === "string" ? b.text : "")).join("\n");
}

/**
 * The dry runs in a transcript in Claude Code's JSONL format (one line per content block, a tool's result as a `user`
 * line), in order: what each dry-run segment of the command runs, and the command's output once its result is in.
 *
 * Each line records the session's folder (`cwd`) when it was written, and a response's lines are written after its tool
 * calls ran: a dry run's own line has the folder after it, `cd`s included. So a dry run started in the folder of the
 * last line before its response, unless an earlier Bash call in that response changed folder; then it's unknown.
 * `cwd` is the hook's own folder, for a transcript whose lines record none.
 */
function dryRuns(transcript, cwd) {
  const runs = [];
  const byId = new Map();
  // Each response by its message id, its lines being written together: where it started, while that's known.
  const responses = new Map();
  let last = cwd;
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const id = entry?.type === "assistant" ? entry.message?.id : undefined;
    if (id !== undefined && !responses.has(id)) responses.set(id, { dir: last });
    const response = id === undefined ? { dir: last } : responses.get(id);
    if (typeof entry?.cwd === "string") last = entry.cwd;
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (entry.type === "assistant" && block?.type === "tool_use" && block.name === "Bash" && typeof block.input?.command === "string") {
        const command = block.input.command;
        if (isDryRun(command)) {
          const run = { keys: initKeys(command, "dry", response.dir), output: "" };
          runs.push(run);
          if (typeof block.id === "string") byId.set(block.id, run);
        }
        if (changesDir(command)) response.dir = undefined;
      }
      if (entry.type === "user" && block?.type === "tool_result" && byId.has(block.tool_use_id)) byId.get(block.tool_use_id).output = resultText(block.content);
    }
  }
  return runs;
}

/** A dry run's plan lines, as `init --dry-run` prints them: "Plan: 5 model calls (…) to claude-sonnet-5-5 on Bedrock (…); at most about $0.94 at list prices". */
const PLAN_LINES = /^Plan: \d+ model calls?\b.*$/gm;

/**
 * The plan of the latest dry run of the same `init` as a paid segment's key: its plan line, null when that dry run
 * printed none it can be matched with, or undefined when no dry run ran the same command.
 */
function planFor(key, runs) {
  if (key === undefined) return undefined;
  for (const run of [...runs].reverse()) {
    const at = run.keys.lastIndexOf(key);
    if (at < 0) continue;
    const plans = run.output.match(PLAN_LINES) ?? [];
    // One plan line per dry-run segment, in order, when every one of them printed its plan.
    return plans.length === run.keys.length ? plans[at].trim().replace(/^Plan: /, "") : null;
  }
  return undefined;
}

const NO_DRY_RUN =
  "sandtable plugin: this `init` calls a model and costs money. Run the same command with `--dry-run` first, then write its plan to the engineer as your own message: the calls, the model, the provider and the dollar bound. If they haven't authorized model steps, end your turn there and wait for their go-ahead. Then run it.";

/**
 * What the hook does with a Bash command, given the session's transcript: nothing for anything but a paid init;
 * a denial for a paid init with no dry run before it; otherwise a message for the engineer with the plan of the latest
 * dry run of that same init, or with what it costs in general when no dry run of it printed a plan.
 */
function decide(command, transcript, cwd) {
  if (!isPaidInit(command)) return undefined;
  const runs = dryRuns(transcript, cwd);
  if (!runs.length) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: NO_DRY_RUN } };
  const plans = initKeys(command, "paid", cwd).map((key) => planFor(key, runs));
  if (plans.every((p) => typeof p === "string")) {
    return { systemMessage: `sandtable: Claude is running a model-backed init. ${plans.length === 1 ? "Its dry run's plan" : "Its dry runs' plans"}: ${plans.join("; then ")}.` };
  }
  if (plans.some((p) => p === undefined)) {
    return { systemMessage: "sandtable: Claude is running a model-backed init that differs from its dry runs, so its plan isn't known. It calls a model and costs money." };
  }
  return { systemMessage: "sandtable: Claude is running a model-backed init, which calls a model and costs money. Its dry run printed no plan." };
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const command = input?.tool_input?.command;
  if (input?.tool_name !== "Bash" || typeof command !== "string" || !isPaidInit(command)) return;
  let transcript;
  try {
    transcript = readFileSync(input.transcript_path, "utf8");
  } catch {
    return;
  }
  const out = decide(command, transcript, typeof input.cwd === "string" ? input.cwd : undefined);
  if (out) process.stdout.write(JSON.stringify(out));
}

main();
