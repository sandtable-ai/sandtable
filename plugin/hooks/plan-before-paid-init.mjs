#!/usr/bin/env node
// A PreToolUse hook for Bash: a model-backed `sandtable init` (with --sop or --transcripts, without --dry-run) runs only
// after a dry run of it and a message of the agent's own, since that dry run, that tells the engineer the plan: the
// calls and a dollar amount. The drafting skill asks for both; this holds the agent to it on any model. Anything it
// can't read, it lets through: the hook only ever blocks a call it knows is a paid init without its plan.

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

/** A message that gives the plan: the calls and what they cost, as "Plan: 5 calls … at most about $0.94". */
const PLAN = (text) => /\bcalls?\b/i.test(text) && /\$\s?\d|\d\s?(?:usd|dollars?)\b|\b(?:usd|us\$)\s?\d/i.test(text);

/** This hook's own reasons start with this, so a denied call can be found again in the transcript. */
const MARK = "sandtable plugin: ";

/**
 * The agent's text blocks and Bash commands, and this hook's denials, in order, from a transcript in Claude Code's
 * JSONL format: one line per content block, a tool's result as a `user` line.
 */
function events(transcript) {
  const out = [];
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(entry?.message?.content)) continue;
    if (entry.type === "user") {
      for (const block of entry.message.content) {
        if (block?.type === "tool_result" && JSON.stringify(block.content ?? "").includes(MARK)) out.push({ kind: "denied" });
      }
      continue;
    }
    if (entry.type !== "assistant") continue;
    for (const block of entry.message.content) {
      if (block?.type === "text" && typeof block.text === "string") out.push({ kind: "text", text: block.text });
      if (block?.type === "tool_use" && block.name === "Bash" && typeof block.input?.command === "string") out.push({ kind: "bash", command: block.input.command });
    }
  }
  return out;
}

const NO_DRY_RUN =
  "sandtable plugin: this `init` calls a model and costs money. Run the same command with `--dry-run` first, then write its plan to the engineer as your own message: the calls, the model, the provider and the dollar bound. If they haven't authorized model steps, end your turn there and wait for their go-ahead. Then run it.";
const NO_PLAN =
  'sandtable plugin: before this model-backed `init`, write the engineer the dry run\'s plan as your own message: the calls, the model, the provider and the dollar bound, such as "Plan: 5 calls to claude-sonnet-5-5 on Bedrock, at most about $0.94. You authorized model steps, so I\'m running it." The `Plan:` line in the command\'s output doesn\'t count: the engineer reads your messages, not tool output. If they haven\'t authorized model steps, end your turn after the plan and wait for their go-ahead instead. Then run the command again.';

/**
 * Why this Bash call must not run yet, or undefined when it may: it isn't a paid init, or the transcript shows a dry run
 * followed by the agent's own plan message. After this hook has denied a call once since the dry run, any message of
 * the agent's counts, so a plan worded in a way this hook doesn't recognise can't block it again and again.
 */
function denial(command, transcript) {
  if (!isPaidInit(command)) return undefined;
  const seen = events(transcript);
  let dry = -1;
  seen.forEach((e, i) => {
    if (e.kind === "bash" && isDryRun(e.command)) dry = i;
  });
  if (dry < 0) return NO_DRY_RUN;
  const after = seen.slice(dry + 1);
  if (after.some((e) => e.kind === "text" && PLAN(e.text))) return undefined;
  const firstDenial = after.findIndex((e) => e.kind === "denied");
  if (firstDenial >= 0 && after.slice(firstDenial + 1).some((e) => e.kind === "text" && e.text.trim())) return undefined;
  return NO_PLAN;
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
  const reason = denial(command, transcript);
  if (!reason) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
}

main();
