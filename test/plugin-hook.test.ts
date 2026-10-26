import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The plugin's PreToolUse hook (#397): a model-backed `init` runs only after its dry run and the agent's own plan
// message. Each test feeds the hook what Claude Code would, a tool call on stdin and the session's JSONL transcript.

const hook = path.resolve("plugin/hooks/plan-before-paid-init.mjs");
const dir = mkdtempSync(path.join(os.tmpdir(), "sandtable-hook-"));

const DRY = "npx sandtable-ai init --sop ./discovery/sop.md --transcripts ./discovery/transcripts -o ./sandtable --provider bedrock --region eu-west-1 -m claude-sonnet-5-5 --dry-run";
const PAID = DRY.replace(" --dry-run", "");
const PLAN = "Plan: 5 calls to claude-sonnet-5-5 on Bedrock, at most about $0.94. You authorized model steps, so I'm running it.";

const assistant = (...content: object[]) => JSON.stringify({ type: "assistant", message: { role: "assistant", content } });
const bash = (command: string) => ({ type: "tool_use", id: "t", name: "Bash", input: { command } });
const text = (t: string) => ({ type: "text", text: t });
const result = (t: string) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: t }] } });

/** The hook's decision on a Bash command, after a transcript of these lines: the deny reason, or undefined. */
function decide(command: string, lines: string[], tool = "Bash"): string | undefined {
  const transcript = path.join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(transcript, lines.join("\n") + "\n");
  const input = JSON.stringify({ session_id: "s", transcript_path: transcript, cwd: dir, hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command } });
  const res = spawnSync(process.execPath, [hook], { input, encoding: "utf8" });
  expect(res.status).toBe(0);
  if (!res.stdout.trim()) return undefined;
  const out = JSON.parse(res.stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
  expect(out.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
  return out.hookSpecificOutput.permissionDecisionReason;
}

const dryRun = [assistant(text("Next I'm running a dry run of the model steps."), bash(DRY)), result("Plan: 5 model calls … at most about $0.94 at list prices\nDry run: no model was called")];

describe("the plugin's plan-before-paid-init hook", () => {
  it("lets every other command through: free inits, dry runs, other tools, other programs", () => {
    expect(decide("npx sandtable-ai init --openapi ./discovery/openapi.yaml -o ./sandtable", [])).toBeUndefined();
    expect(decide(DRY, [])).toBeUndefined();
    expect(decide("npx sandtable-ai lint ./sandtable", [])).toBeUndefined();
    expect(decide("grep -r 'init --sop' docs", [])).toBeUndefined();
    expect(decide(PAID, [], "Read")).toBeUndefined();
  });

  it("holds a paid init with no dry run before it", () => {
    expect(decide(PAID, [])).toMatch(/Run the same command with `--dry-run` first/);
  });

  it("holds a paid init that comes straight after the dry run's output, which doesn't count as the agent's message", () => {
    expect(decide(PAID, dryRun)).toMatch(/write the engineer the dry run's plan as your own message/);
  });

  it("lets the paid init run once the agent has written the plan since the dry run", () => {
    expect(decide(PAID, [...dryRun, assistant(text(PLAN))])).toBeUndefined();
    // In the same message as the command, before it.
    expect(decide(PAID, [...dryRun, assistant(text(PLAN), bash(PAID))])).toBeUndefined();
    // After the engineer's go-ahead in a later turn.
    expect(decide(PAID, [...dryRun, assistant(text("This will make 5 calls, at most about $0.94. Shall I run it?")), JSON.stringify({ type: "user", message: { role: "user", content: "yes, go" } })])).toBeUndefined();
  });

  it("accepts a plan with the cost in USD, and after one denial any message of the agent's, so it never blocks twice", () => {
    expect(decide(PAID, [...dryRun, assistant(text("5 model calls on Bedrock, at most about 0.94 USD."))])).toBeUndefined();
    const denied = result("Hook PreToolUse:Bash denied this tool call: sandtable plugin: before this model-backed `init`, write the engineer …");
    expect(decide(PAID, [...dryRun, assistant(bash(PAID)), denied, assistant(text("Five Bedrock calls, under a dollar. Running the draft."))])).toBeUndefined();
    // A denial without any message after it still holds the call.
    expect(decide(PAID, [...dryRun, assistant(bash(PAID)), denied])).toMatch(/write the engineer/);
  });

  it("counts only a plan written after the latest dry run", () => {
    const stale = [assistant(text(PLAN)), ...dryRun];
    expect(decide(PAID, stale)).toMatch(/write the engineer the dry run's plan/);
    // A message without the calls and the dollar amount isn't a plan.
    expect(decide(PAID, [...dryRun, assistant(text("Running the drafting step now."))])).toMatch(/write the engineer/);
  });

  it("sees a paid init in a chained command, a loop and the -p form", () => {
    expect(decide(`${DRY} && ${PAID}`, [])).toMatch(/--dry-run` first/);
    expect(decide(`${DRY} && ${PAID}`, dryRun)).toMatch(/write the engineer/);
    expect(decide('for f in discovery/transcripts/*.txt; do npx sandtable-ai init --transcripts "$f" -o ./sandtable; done', dryRun)).toMatch(/write the engineer/);
    expect(decide("npx -p sandtable-ai -p @anthropic-ai/bedrock-sdk sandtable init --sop ./discovery/sop.md -o ./sandtable --provider bedrock", [])).toMatch(/--dry-run` first/);
    expect(decide("npx sandtable-ai@1.0.0 init --transcripts ./calls -o ./sandtable", [])).toMatch(/--dry-run` first/);
  });

  it("lets the call through when it can't read the transcript or its input", () => {
    const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: PAID }, transcript_path: path.join(dir, "missing.jsonl") });
    expect(spawnSync(process.execPath, [hook], { input, encoding: "utf8" }).stdout).toBe("");
    expect(spawnSync(process.execPath, [hook], { input: "not json", encoding: "utf8" }).stdout).toBe("");
    // Lines it can't parse are skipped, not fatal.
    expect(decide(PAID, ["{not json", ...dryRun, assistant(text(PLAN))])).toBeUndefined();
  });

  it("is registered for Bash in the plugin's hooks.json, by a path inside the plugin", () => {
    const config = JSON.parse(readFileSync(path.resolve("plugin/hooks/hooks.json"), "utf8")) as { hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string; args: string[] }[] }[] } };
    const [entry] = config.hooks.PreToolUse;
    expect(entry!.matcher).toBe("Bash");
    // Exec form: the path is one argument, so spaces and backslashes in the plugin's folder need no quoting.
    expect(entry!.hooks[0]).toMatchObject({ type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/hooks/plan-before-paid-init.mjs"] });
  });
});
