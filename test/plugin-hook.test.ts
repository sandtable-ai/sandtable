import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The plugin's hook (#397): a model-backed `init` runs only after its dry run, and after the dry run the agent is told
// to write the engineer the plan. Each test feeds the hook what Claude Code would: a tool call on stdin, with the
// session's JSONL transcript before PreToolUse, or the call's output after it on PostToolUse.

const hook = path.resolve("plugin/hooks/plan-before-paid-init.mjs");
const dir = mkdtempSync(path.join(os.tmpdir(), "sandtable-hook-"));

const DRY = "npx sandtable-ai init --sop ./discovery/sop.md --transcripts ./discovery/transcripts -o ./sandtable --provider bedrock --region eu-west-1 -m claude-sonnet-5-5 --dry-run";
const PAID = DRY.replace(" --dry-run", "");
const PLAN = "Plan: 5 calls to claude-sonnet-5-5 on Bedrock, at most about $0.94. You authorized model steps, so I'm running it.";
const PLAN_LINE = "Plan: 5 model calls (1 for the SOP, 4 for transcripts) to claude-sonnet-5-5 on Bedrock (eu-west-1, eu.anthropic.claude-sonnet-5-5); at most about $0.94 at list prices";

const assistant = (...content: object[]) => JSON.stringify({ type: "assistant", message: { role: "assistant", content } });
const bash = (command: string) => ({ type: "tool_use", id: "t", name: "Bash", input: { command } });
const text = (t: string) => ({ type: "text", text: t });
const result = (t: string) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: t }] } });

/** The hook's PreToolUse decision on a Bash command, after a transcript of these lines: the deny reason, or undefined. */
function decide(command: string, lines: string[], tool = "Bash"): string | undefined {
  const transcript = path.join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(transcript, lines.join("\n") + "\n");
  const input = JSON.stringify({ session_id: "s", transcript_path: transcript, cwd: dir, hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command }, tool_use_id: "toolu_now" });
  const res = spawnSync(process.execPath, [hook], { input, encoding: "utf8" });
  expect(res.status).toBe(0);
  if (!res.stdout.trim()) return undefined;
  const out = JSON.parse(res.stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
  expect(out.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
  return out.hookSpecificOutput.permissionDecisionReason;
}

/** What the hook tells the agent on PostToolUse, after a Bash command with this output, or undefined. */
function after(command: string, output: unknown, tool = "Bash"): string | undefined {
  const input = JSON.stringify({ session_id: "s", transcript_path: path.join(dir, "unused.jsonl"), cwd: dir, hook_event_name: "PostToolUse", tool_name: tool, tool_input: { command }, tool_response: output });
  const res = spawnSync(process.execPath, [hook], { input, encoding: "utf8" });
  expect(res.status).toBe(0);
  if (!res.stdout.trim()) return undefined;
  const out = JSON.parse(res.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
  return out.hookSpecificOutput.additionalContext;
}

const dryRun = [assistant(text("Next I'm running a dry run of the model steps."), bash(DRY)), result(`${PLAN_LINE}\nDry run: no model was called`)];

describe("the plugin's plan-before-paid-init hook, before a call", () => {
  it("lets every other command through: free inits, dry runs, other tools, other programs", () => {
    expect(decide("npx sandtable-ai init --openapi ./discovery/openapi.yaml -o ./sandtable", [])).toBeUndefined();
    expect(decide(DRY, [])).toBeUndefined();
    expect(decide("npx sandtable-ai lint ./sandtable", [])).toBeUndefined();
    expect(decide("grep -r 'init --sop' docs", [])).toBeUndefined();
    expect(decide(PAID, [], "Read")).toBeUndefined();
  });

  it("holds a paid init with no dry run before it", () => {
    expect(decide(PAID, [])).toMatch(/^sandtable plugin: .*Run the same command with `--dry-run` first/);
    expect(decide(PAID, [assistant(text(PLAN))])).toMatch(/--dry-run` first/);
  });

  it("lets the paid init run after a dry run in an earlier response, with the plan in the paid init's own response", () => {
    // Claude Code writes a response to the transcript only after its tool calls have run, so the plan written just
    // before the paid init isn't on disk yet: the transcript ends at the dry run's output. That must not hold the call.
    expect(decide(PAID, dryRun)).toBeUndefined();
    // The same after a denial for running it before the dry run, as an agent that skipped the dry run then recovers.
    const denied = result(`Hook PreToolUse:Bash denied this tool call: ${decide(PAID, [])}`);
    expect(decide(PAID, [assistant(bash(PAID)), denied, ...dryRun])).toBeUndefined();
    // And when the plan is already on disk, in an earlier response, or after the engineer's go-ahead.
    expect(decide(PAID, [...dryRun, assistant(text(PLAN))])).toBeUndefined();
    expect(decide(PAID, [...dryRun, assistant(text("This will make 5 calls, at most about $0.94. Shall I run it?")), JSON.stringify({ type: "user", message: { role: "user", content: "yes, go" } })])).toBeUndefined();
  });

  it("doesn't count a dry run that only the engineer's text or a tool's output mentions", () => {
    expect(decide(PAID, [JSON.stringify({ type: "user", message: { role: "user", content: `First run ${DRY}` } }), result(`$ ${DRY}\n${PLAN_LINE}`)])).toMatch(/--dry-run` first/);
    expect(decide(PAID, [assistant(text(`I'll run ${DRY} next.`))])).toMatch(/--dry-run` first/);
  });

  it("sees a paid init in a chained command, a loop and the -p form", () => {
    expect(decide(`${DRY} && ${PAID}`, [])).toMatch(/--dry-run` first/);
    expect(decide('for f in discovery/transcripts/*.txt; do npx sandtable-ai init --transcripts "$f" -o ./sandtable; done', [])).toMatch(/--dry-run` first/);
    expect(decide("npx -p sandtable-ai -p @anthropic-ai/bedrock-sdk sandtable init --sop ./discovery/sop.md -o ./sandtable --provider bedrock", [])).toMatch(/--dry-run` first/);
    expect(decide("npx sandtable-ai@1.0.0 init --transcripts ./calls -o ./sandtable", [])).toMatch(/--dry-run` first/);
    expect(decide(`cd engagement && ${PAID} 2>&1 | tail -20`, dryRun)).toBeUndefined();
  });

  it("lets the call through when it can't read the transcript or its input", () => {
    const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: PAID }, transcript_path: path.join(dir, "missing.jsonl") });
    expect(spawnSync(process.execPath, [hook], { input, encoding: "utf8" }).stdout).toBe("");
    expect(spawnSync(process.execPath, [hook], { input: "not json", encoding: "utf8" }).stdout).toBe("");
    // Lines it can't parse are skipped, not fatal.
    expect(decide(PAID, ["{not json", ...dryRun])).toBeUndefined();
  });
});

describe("the plugin's plan-before-paid-init hook, after a call", () => {
  it("after a dry run that printed its plan, tells the agent to write the engineer that plan before the paid run", () => {
    const told = after(DRY, { stdout: `${PLAN_LINE}\nDry run: no model was called`, stderr: "", interrupted: false });
    expect(told).toMatch(/^sandtable plugin: that was the dry run, so nothing was spent\./);
    expect(told).toContain(`Its plan: "${PLAN_LINE}".`);
    expect(told).toContain("write the engineer this plan as your own message");
    expect(told).toContain("If they haven't authorized model steps, end your turn after the plan and wait for their go-ahead.");
    // The plan line found in stderr, in a piped command, or in a response of another shape.
    expect(after(`${DRY} 2>&1 | head -20`, { stdout: "", stderr: PLAN_LINE })).toContain(PLAN_LINE);
    expect(after(DRY, `${PLAN_LINE}\n`)).toContain(PLAN_LINE);
  });

  it("says nothing after any other call, or a dry run that printed no plan", () => {
    expect(after(PAID, { stdout: `${PLAN_LINE}\nWrote ./sandtable` })).toBeUndefined();
    expect(after(`${DRY} && ${PAID}`, { stdout: PLAN_LINE })).toBeUndefined();
    expect(after("npx sandtable-ai init --openapi ./discovery/openapi.yaml -o ./sandtable --dry-run", { stdout: "Dry run: would write ./sandtable" })).toBeUndefined();
    expect(after(DRY, { stdout: "", stderr: "error: --sop: no such file ./discovery/sop.md" })).toBeUndefined();
    expect(after(DRY, { stdout: PLAN_LINE }, "Read")).toBeUndefined();
    expect(spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: DRY } }), encoding: "utf8" }).stdout).toBe("");
  });
});

describe("the plugin's hooks.json", () => {
  it("registers the hook for Bash before and after a call, by a path inside the plugin", () => {
    type Entry = { matcher: string; hooks: { type: string; command: string; args: string[] }[] };
    const config = JSON.parse(readFileSync(path.resolve("plugin/hooks/hooks.json"), "utf8")) as { hooks: Record<string, Entry[]> };
    for (const event of ["PreToolUse", "PostToolUse"]) {
      const entry = config.hooks[event]!.find((e) => e.hooks.some((h) => h.args.some((a) => a.endsWith("/plan-before-paid-init.mjs"))));
      expect(entry?.matcher, event).toBe("Bash");
      // Exec form: the path is one argument, so spaces and backslashes in the plugin's folder need no quoting.
      expect(entry!.hooks[0]).toMatchObject({ type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/hooks/plan-before-paid-init.mjs"] });
    }
  });
});
