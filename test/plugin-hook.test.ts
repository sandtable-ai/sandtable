import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The plugin's plan hook (#397): a model-backed `init` runs only after its dry run, and when it runs, the engineer sees
// that dry run's plan as a message from the plugin. Each test feeds the hook what Claude Code would: a tool call on
// stdin and the session's JSONL transcript, as it stands before the call's own response is written.

const hook = path.resolve("plugin/hooks/plan-before-paid-init.mjs");
const dir = mkdtempSync(path.join(os.tmpdir(), "sandtable-hook-"));

const DRY = "npx sandtable-ai init --sop ./discovery/sop.md --transcripts ./discovery/transcripts -o ./sandtable --provider bedrock --region eu-west-1 -m claude-sonnet-5-5 --dry-run";
const PAID = DRY.replace(" --dry-run", "");
const PLAN = "Plan: 5 calls to claude-sonnet-5-5 on Bedrock, at most about $0.94. You authorized model steps, so I'm running it.";
const PLAN_LINE = "Plan: 5 model calls (1 for the SOP, 4 for transcripts) to claude-sonnet-5-5 on Bedrock (eu-west-1, eu.anthropic.claude-sonnet-5-5); at most about $0.94 at list prices";

let ids = 0;
const assistant = (...content: object[]) => JSON.stringify({ type: "assistant", message: { role: "assistant", content } });
const bash = (command: string, id = `toolu_${++ids}`) => ({ type: "tool_use", id, name: "Bash", input: { command } });
const text = (t: string) => ({ type: "text", text: t });
const result = (id: string, content: unknown) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } });

/** A dry run and its output, as two transcript lines. */
function dryRun(output: unknown = `${PLAN_LINE}\nDry run: no model was called and nothing was written.`, command = DRY): string[] {
  const call = bash(command);
  return [assistant(text("Next I'm running a dry run of the model steps."), call), result(call.id, output)];
}

type Output = { systemMessage?: string; hookSpecificOutput?: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };

/** What the hook prints for a Bash command after a transcript of these lines, parsed, or undefined when it prints nothing. */
function run(command: string, lines: string[], tool = "Bash"): Output | undefined {
  const transcript = path.join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(transcript, lines.join("\n") + "\n");
  const input = JSON.stringify({ session_id: "s", transcript_path: transcript, cwd: dir, hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command }, tool_use_id: "toolu_now" });
  const res = spawnSync(process.execPath, [hook], { input, encoding: "utf8" });
  expect(res.status).toBe(0);
  return res.stdout.trim() ? (JSON.parse(res.stdout) as Output) : undefined;
}

const denial = (command: string, lines: string[]) => {
  const out = run(command, lines);
  expect(out?.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
  expect(out?.systemMessage).toBeUndefined();
  return out!.hookSpecificOutput!.permissionDecisionReason;
};

const shown = (command: string, lines: string[]) => {
  const out = run(command, lines);
  // It never decides for the call: the engineer's permission settings apply as they would without the plugin.
  expect(out?.hookSpecificOutput).toBeUndefined();
  return out?.systemMessage;
};

describe("the plugin's plan-before-paid-init hook", () => {
  it("lets every other command through without a word: free inits, dry runs, other tools, other programs", () => {
    expect(run("npx sandtable-ai init --openapi ./discovery/openapi.yaml -o ./sandtable", [])).toBeUndefined();
    expect(run(DRY, [])).toBeUndefined();
    expect(run("npx sandtable-ai lint ./sandtable", dryRun())).toBeUndefined();
    expect(run("grep -r 'init --sop' docs", [])).toBeUndefined();
    expect(run(PAID, [], "Read")).toBeUndefined();
  });

  it("holds a paid init with no dry run before it", () => {
    expect(denial(PAID, [])).toMatch(/^sandtable plugin: this `init` calls a model and costs money\. Run the same command with `--dry-run` first/);
    // A plan the agent wrote doesn't stand in for the dry run, and neither does a dry run only the engineer's text or a tool's output mentions.
    expect(denial(PAID, [assistant(text(PLAN))])).toMatch(/--dry-run` first/);
    expect(denial(PAID, [JSON.stringify({ type: "user", message: { role: "user", content: `First run ${DRY}` } }), result("x", `$ ${DRY}\n${PLAN_LINE}`)])).toMatch(/--dry-run` first/);
    expect(denial(PAID, [assistant(text(`I'll run ${DRY} next.`))])).toMatch(/--dry-run` first/);
  });

  it("after a dry run, lets the paid init run and shows the engineer the dry run's plan", () => {
    // The transcript ends at the dry run's output: a plan written just before the paid init, in its response, isn't
    // on disk yet. That must not matter.
    expect(shown(PAID, dryRun())).toBe(`sandtable: Claude is running a model-backed init. Its dry run's plan: ${PLAN_LINE.replace("Plan: ", "")}.`);
    // The same with the plan already written in an earlier response, or after the engineer's go-ahead.
    expect(shown(PAID, [...dryRun(), assistant(text(PLAN))])).toContain(PLAN_LINE.replace("Plan: ", ""));
    expect(shown(PAID, [...dryRun(), assistant(text("This will make 5 calls, at most about $0.94. Shall I run it?")), JSON.stringify({ type: "user", message: { role: "user", content: "yes, go" } })])).toContain(PLAN_LINE.replace("Plan: ", ""));
    // And after a denial for running it before the dry run.
    const early = bash(PAID);
    expect(shown(PAID, [assistant(early), result(early.id, `PreToolUse:Bash hook error: ${denial(PAID, [])}`), ...dryRun()])).toContain(PLAN_LINE.replace("Plan: ", ""));
  });

  it("reads the plan from the latest dry run, in either shape of a tool result", () => {
    const older = PLAN_LINE.replace("5 model calls (1 for the SOP, 4 for transcripts)", "2 model calls (1 for the SOP, 1 for transcripts)").replace("$0.94", "$0.31");
    expect(shown(PAID, [...dryRun(older), ...dryRun()])).toContain("$0.94");
    expect(shown(PAID, dryRun([{ type: "text", text: `${PLAN_LINE}\nDry run: no model was called` }]))).toContain(PLAN_LINE.replace("Plan: ", ""));
    expect(shown(PAID, dryRun(`npm warn exec …\n${PLAN_LINE}`, `${DRY} 2>&1 | tail -5`))).toContain(PLAN_LINE.replace("Plan: ", ""));
  });

  it("quotes a plan only from a dry run of the same init, however it is spelled", () => {
    const plan = PLAN_LINE.replace("Plan: ", "");
    // The same calls: short and long flags, --x=v, ./ and trailing slashes, -o left at its default, redirections, and
    // flags that don't change the calls (the free --openapi step, the AWS profile, --force) on either side.
    const spelled = "npx -p sandtable-ai -p @anthropic-ai/bedrock-sdk sandtable init --transcripts=discovery/transcripts/ --sop discovery/sop.md --model claude-sonnet-5-5 --region eu-west-1 --provider bedrock --out sandtable --aws-profile demo-profile --force 2>&1";
    expect(shown(spelled, dryRun())).toContain(plan);
    expect(shown(PAID, dryRun(undefined, `npx sandtable-ai init --openapi ./discovery/openapi.yaml ${DRY.split(" init ")[1]} > plan.txt`))).toContain(plan);
    const differs = "sandtable: Claude is running a model-backed init that differs from its dry runs, so its plan isn't known. It calls a model and costs money.";
    // A dry run of the SOP alone says nothing about a run that drafts the transcripts too, or one on another model.
    const sopOnly = "npx sandtable-ai init --sop ./discovery/sop.md -o ./sandtable --provider bedrock --region eu-west-1 -m claude-sonnet-5-5";
    const sopPlan = "Plan: 1 model call (1 for the SOP) to claude-sonnet-5-5 on Bedrock (eu-west-1, eu.anthropic.claude-sonnet-5-5); at most about $0.19 at list prices";
    expect(shown(PAID, dryRun(sopPlan, `${sopOnly} --dry-run`))).toBe(differs);
    expect(shown(sopOnly, dryRun())).toBe(differs);
    expect(shown(PAID.replace("claude-sonnet-5-5", "claude-opus-5-5"), dryRun())).toBe(differs);
    expect(shown(PAID.replace("-o ./sandtable", "-o ./other"), dryRun())).toBe(differs);
    // The latest dry run of that same init counts, even with another dry run after it.
    expect(shown(sopOnly, [...dryRun(sopPlan, `${sopOnly} --dry-run`), ...dryRun()])).toContain("1 model call (1 for the SOP)");
    // In a dry run of two inits, each plan line goes with its init, in order.
    const both = `${sopOnly} --dry-run; ${DRY}`;
    expect(shown(PAID, dryRun(`${sopPlan}\n${PLAN_LINE}`, both))).toContain(plan);
    expect(shown(sopOnly, dryRun(`${sopPlan}\n${PLAN_LINE}`, both))).toContain("$0.19");
  });

  it("counts the environment that picks the region, provider or Bedrock client, unless a flag overrides it", () => {
    const differs = "sandtable: Claude is running a model-backed init that differs from its dry runs, so its plan isn't known. It calls a model and costs money.";
    const noRegion = PAID.replace(" --region eu-west-1", "");
    const euDry = dryRun(undefined, `AWS_REGION=eu-west-1 ${noRegion} --dry-run`);
    expect(shown(`AWS_REGION=eu-west-1 ${noRegion}`, euDry)).toContain(PLAN_LINE.replace("Plan: ", ""));
    expect(shown(`env AWS_REGION=eu-west-1 ${noRegion}`, euDry)).toContain(PLAN_LINE.replace("Plan: ", ""));
    expect(shown(`export AWS_REGION=eu-west-1 && ${noRegion}`, euDry)).toContain(PLAN_LINE.replace("Plan: ", ""));
    // Another region, set either way, or none the command shows: the eu plan doesn't describe it.
    expect(shown(`AWS_REGION=us-east-1 ${noRegion}`, euDry)).toBe(differs);
    expect(shown(`export AWS_REGION="us-east-1"; ${noRegion}`, euDry)).toBe(differs);
    expect(shown(noRegion, euDry)).toBe(differs);
    const noProvider = PAID.replace(" --provider bedrock", "");
    expect(shown(`SANDTABLE_PROVIDER=anthropic ${noProvider}`, dryRun(undefined, `SANDTABLE_PROVIDER=bedrock ${noProvider} --dry-run`))).toBe(differs);
    expect(shown(`SANDTABLE_BEDROCK_CLIENT=mantle ${PAID}`, dryRun())).toBe(differs);
    // --region and --provider override the environment, and other variables don't change the calls.
    expect(shown(`AWS_REGION=us-east-1 SANDTABLE_PROVIDER=anthropic ${PAID}`, dryRun())).toContain(PLAN_LINE.replace("Plan: ", ""));
    expect(shown(`AWS_PROFILE=demo-profile NO_COLOR=1 ${PAID}`, dryRun())).toContain(PLAN_LINE.replace("Plan: ", ""));
  });

  it("still says what the call is when the dry run of it printed no plan, or has no output yet", () => {
    const none = "sandtable: Claude is running a model-backed init, which calls a model and costs money. Its dry run printed no plan.";
    expect(shown(PAID, dryRun("error: --sop: no such file ./discovery/sop.md"))).toBe(none);
    expect(shown(PAID, [...dryRun(), ...dryRun("error: --region: unknown")])).toBe(none);
    expect(shown(PAID, [assistant(bash(DRY))])).toBe(none);
  });

  it("sees a paid init in a chained command, a loop, the -p form and the forms with -- before init", () => {
    expect(denial(`${DRY} && ${PAID}`, [])).toMatch(/--dry-run` first/);
    expect(denial('for f in discovery/transcripts/*.txt; do npx sandtable-ai init --transcripts "$f" -o ./sandtable; done', [])).toMatch(/--dry-run` first/);
    expect(denial("npx -p sandtable-ai -p @anthropic-ai/bedrock-sdk sandtable init --sop ./discovery/sop.md -o ./sandtable --provider bedrock", [])).toMatch(/--dry-run` first/);
    expect(denial("npx sandtable-ai@1.1.0 init --transcripts ./calls -o ./sandtable", [])).toMatch(/--dry-run` first/);
    expect(shown(`cd engagement && ${PAID} 2>&1 | tail -20`, dryRun())).toContain(PLAN_LINE.replace("Plan: ", ""));
    const args = PAID.split(" init ")[1];
    for (const form of ["npm exec sandtable-ai --", "npm exec --yes sandtable-ai@1.1.2 --", "npm run sandtable --", "npx sandtable-ai --"]) {
      expect(denial(`${form} init ${args}`, [])).toMatch(/--dry-run` first/);
      expect(run(`${form} init ${args} --dry-run`, [])).toBeUndefined();
      // The same init however it is called: a dry run in one form gives its plan to a paid run in another.
      expect(shown(`${form} init ${args}`, dryRun())).toContain(PLAN_LINE.replace("Plan: ", ""));
      expect(shown(PAID, dryRun(undefined, `${form} init ${args} --dry-run`))).toContain(PLAN_LINE.replace("Plan: ", ""));
    }
  });

  it("lets the call through without a word when it can't read the transcript or its input", () => {
    const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: PAID }, transcript_path: path.join(dir, "missing.jsonl") });
    expect(spawnSync(process.execPath, [hook], { input, encoding: "utf8" }).stdout).toBe("");
    expect(spawnSync(process.execPath, [hook], { input: "not json", encoding: "utf8" }).stdout).toBe("");
    // Lines it can't parse are skipped, not fatal.
    expect(shown(PAID, ["{not json", ...dryRun()])).toContain(PLAN_LINE.replace("Plan: ", ""));
  });

  it("is registered for Bash in the plugin's hooks.json, next to the install hook, by a path inside the plugin", () => {
    const config = JSON.parse(readFileSync(path.resolve("plugin/hooks/hooks.json"), "utf8")) as { hooks: Record<string, { matcher: string; hooks: { type: string; command: string; args: string[] }[] }[]> };
    expect(Object.keys(config.hooks)).toEqual(["PreToolUse"]);
    const bashHooks = config.hooks.PreToolUse!.find((e) => e.matcher === "Bash")!.hooks;
    // Exec form: the path is one argument, so spaces and backslashes in the plugin's folder need no quoting.
    expect(bashHooks).toContainEqual(expect.objectContaining({ type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/hooks/plan-before-paid-init.mjs"] }));
    expect(bashHooks).toContainEqual(expect.objectContaining({ args: ["${CLAUDE_PLUGIN_ROOT}/hooks/install-in-own-project.mjs"] }));
  });
});
