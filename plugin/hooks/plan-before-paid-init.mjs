#!/usr/bin/env node
// A hook for Bash, on PreToolUse and PostToolUse: a model-backed `sandtable init` (with --sop or --transcripts, without
// --dry-run) runs only after a dry run of it, and once that dry run has printed its plan, the agent is told to write
// the engineer that plan as its own message before the paid run. The drafting skill asks for both; this holds the
// agent to them on any model. Anything it can't read, it lets through: the hook only ever blocks a call it knows is a
// paid init with no dry run before it.
//
// Why the plan message itself isn't checked before the paid run: Claude Code writes a response to the transcript only
// after its tool calls have run, so when PreToolUse fires, the transcript ends at the previous response. A plan written
// in the same response as the paid init, which is the usual way to write it, can't be seen yet. The dry run is always
// in an earlier response, since its output is what the plan comes from.

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

/** The Bash commands the agent ran, in order, from a transcript in Claude Code's JSONL format: one line per content block. */
function commands(transcript) {
  const out = [];
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "assistant" || !Array.isArray(entry?.message?.content)) continue;
    for (const block of entry.message.content) {
      if (block?.type === "tool_use" && block.name === "Bash" && typeof block.input?.command === "string") out.push(block.input.command);
    }
  }
  return out;
}

/** The dry run's plan line, as `init --dry-run` prints it: "Plan: 5 model calls (…) to claude-sonnet-5-5 on Bedrock (…); at most about $0.94 at list prices". */
const PLAN_LINE = /^Plan: \d+ model calls?\b.*$/m;

/** This hook's own messages start with this, so a denied call can be found again in a transcript. */
const MARK = "sandtable plugin: ";

const NO_DRY_RUN = `${MARK}this \`init\` calls a model and costs money. Run the same command with \`--dry-run\` first, then write its plan to the engineer as your own message: the calls, the model, the provider and the dollar bound. If they haven't authorized model steps, end your turn there and wait for their go-ahead. Then run it.`;

const writeThePlan = (plan) =>
  `${MARK}that was the dry run, so nothing was spent. Its plan: "${plan}". Before you run the command without \`--dry-run\`, write the engineer this plan as your own message: the calls, the model, the provider and the dollar bound, such as "Plan: 5 calls to claude-sonnet-5-5 on Bedrock, at most about $0.94. You authorized model steps, so I'm running it." The engineer reads your messages, not tool output. If they haven't authorized model steps, end your turn after the plan and wait for their go-ahead.`;

/** Before a Bash call: why it must not run yet, or undefined when it may. Only a paid init with no dry run before it is held. */
function denial(command, transcript) {
  if (!isPaidInit(command)) return undefined;
  return commands(transcript).some(isDryRun) ? undefined : NO_DRY_RUN;
}

/** After a Bash call: what the agent is told next, or undefined. Only a dry run that printed its plan gets a message. */
function afterCall(command, response) {
  if (!isDryRun(command)) return undefined;
  const output = typeof response === "string" ? response : [response?.stdout, response?.stderr].filter((s) => typeof s === "string").join("\n") || JSON.stringify(response ?? "");
  const plan = PLAN_LINE.exec(output)?.[0].trim();
  return plan ? writeThePlan(plan) : undefined;
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const command = input?.tool_input?.command;
  if (input?.tool_name !== "Bash" || typeof command !== "string") return;
  if (input.hook_event_name === "PostToolUse") {
    const context = afterCall(command, input.tool_response);
    if (context) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } }));
    return;
  }
  if (!isPaidInit(command)) return;
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
