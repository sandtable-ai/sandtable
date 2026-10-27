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

/** The shell commands in one Bash call, split where one ends and another can start. */
function segments(command) {
  return command.split(/&&|\|\||[;|\n]/);
}

const INIT = /\bsandtable(?:-ai)?(?:@[\w.^~-]+)?\s+init\b/;
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

/** The text of a tool result's content, a string or a list of text blocks. */
function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (typeof b?.text === "string" ? b.text : "")).join("\n");
}

/**
 * The dry runs in a transcript in Claude Code's JSONL format (one line per content block, a tool's result as a `user`
 * line), in order, each with its output once its result is in.
 */
function dryRuns(transcript) {
  const runs = [];
  const byId = new Map();
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (entry.type === "assistant" && block?.type === "tool_use" && block.name === "Bash" && typeof block.input?.command === "string" && isDryRun(block.input.command)) {
        const run = { output: "" };
        runs.push(run);
        if (typeof block.id === "string") byId.set(block.id, run);
      }
      if (entry.type === "user" && block?.type === "tool_result" && byId.has(block.tool_use_id)) byId.get(block.tool_use_id).output = resultText(block.content);
    }
  }
  return runs;
}

/** The dry run's plan line, as `init --dry-run` prints it: "Plan: 5 model calls (…) to claude-sonnet-5-5 on Bedrock (…); at most about $0.94 at list prices". */
const PLAN_LINE = /^Plan: \d+ model calls?\b.*$/m;

const NO_DRY_RUN =
  "sandtable plugin: this `init` calls a model and costs money. Run the same command with `--dry-run` first, then write its plan to the engineer as your own message: the calls, the model, the provider and the dollar bound. If they haven't authorized model steps, end your turn there and wait for their go-ahead. Then run it.";

/**
 * What the hook does with a Bash command, given the session's transcript: nothing for anything but a paid init;
 * a denial for a paid init with no dry run before it; otherwise a message for the engineer with the latest dry run's
 * plan, or with what it costs in general when that dry run printed none.
 */
function decide(command, transcript) {
  if (!isPaidInit(command)) return undefined;
  const runs = dryRuns(transcript);
  if (!runs.length) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: NO_DRY_RUN } };
  const plan = PLAN_LINE.exec(runs.at(-1).output)?.[0].trim();
  return {
    systemMessage: plan
      ? `sandtable: Claude is running a model-backed init. Its dry run's plan: ${plan.replace(/^Plan: /, "")}.`
      : "sandtable: Claude is running a model-backed init, which calls a model and costs money. Its last dry run printed no plan.",
  };
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
  const out = decide(command, transcript);
  if (out) process.stdout.write(JSON.stringify(out));
}

main();
