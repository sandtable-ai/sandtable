import { gradeTrial, type CheckResult } from "../grade/expectations.ts";
import { checkCall, type CallRecord, type Violation } from "../grade/invariants.ts";
import type { Domain, Task } from "../spec/schema.ts";
import { agentSystemPrompt } from "../sim/prompts.ts";
import type { AgentAdapter, CallTool, UserSimulator } from "../sim/types.ts";
import { diffSnapshots, World, type Change } from "../world/store.ts";
import { coerceArgs, executeTool, toolSchema } from "../world/tools.ts";
import { costOf, recordInto, type Usage } from "./usage.ts";

export type TrajectoryEvent =
  | { type: "user"; text: string }
  | { type: "agent"; text: string; latencyMs: number }
  | { type: "tool"; index: number; name: string; args: unknown; ok: boolean; result?: unknown; error?: string; violations: string[] };

export type EndReason = "user_stop" | "max_turns" | "error";

export interface TrialResult {
  taskId: string;
  trial: number;
  passed: boolean;
  checks: CheckResult[];
  violations: Violation[];
  events: TrajectoryEvent[];
  changes: Change[];
  endReason: EndReason;
  turns: number;
  durationMs: number;
  usage: Usage;
  error?: string;
}

/** Run one simulated conversation between the user simulator and the agent, then grade it. */
export async function runEpisode(input: {
  domain: Domain;
  task: Task;
  agent: AgentAdapter;
  user: UserSimulator;
  trial: number;
}): Promise<TrialResult> {
  const { domain, task, agent, user, trial } = input;
  const started = performance.now();
  const world = new World(domain.world);
  const initial = world.snapshot();
  const events: TrajectoryEvent[] = [];
  const calls: CallRecord[] = [];
  const violations: Violation[] = [];
  const agentMessages: string[] = [];
  const toolsByName = new Map(domain.tools.map((t) => [t.name, t]));
  const usage: Usage = { agent: {}, user: {}, costUsd: 0 };

  const callTool: CallTool = async (name, rawArgs) => {
    const index = calls.length;
    const tool = toolsByName.get(name);
    const record = (rec: CallRecord, found: Violation[] = []) => {
      calls.push(rec);
      violations.push(...found);
      events.push({ type: "tool", index, name, args: rawArgs, ok: rec.ok, result: rec.result, error: rec.error, violations: found.map((v) => v.invariant) });
      return { ok: rec.ok, result: rec.result, error: rec.error };
    };
    if (!tool) return record({ index, name, args: {}, ok: false, error: `unknown tool "${name}"` });
    const coerced = coerceArgs(tool, rawArgs);
    if ("error" in coerced) return record({ index, name, args: {}, ok: false, error: coerced.error });
    const found = checkCall(domain, world, calls, { index, name, args: coerced.args });
    const outcome = executeTool(tool, world, coerced.args);
    return record({ index, name, args: coerced.args, ...outcome }, found);
  };

  const persona = domain.personas.find((p) => p.id === task.persona);
  const maxTurns = task.max_turns ?? domain.max_turns;
  let endReason: EndReason = "max_turns";
  let turns = 0;
  let error: string | undefined;

  try {
    const session = await agent.createSession({
      domain,
      system: agentSystemPrompt(domain),
      tools: domain.tools.map(toolSchema),
      sessionId: `${task.id}#${trial}`,
      recordUsage: (model, u) => recordInto(usage.agent, model, u),
    });
    const sim = await user.createSession({ domain, task, persona, recordUsage: (model, u) => recordInto(usage.user, model, u) });
    let turn = await sim.next(null);
    try {
      while (turns < maxTurns) {
        if (turn.text) events.push({ type: "user", text: turn.text });
        if (turn.stop) {
          endReason = "user_stop";
          break;
        }
        const turnStarted = performance.now();
        const reply = await session.reply(turn.text, callTool);
        events.push({ type: "agent", text: reply, latencyMs: Math.round(performance.now() - turnStarted) });
        agentMessages.push(reply);
        turns++;
        turn = await sim.next(reply);
      }
    } finally {
      await session.close?.();
    }
  } catch (err) {
    endReason = "error";
    error = err instanceof Error ? err.message : String(err);
  }

  const keys = Object.fromEntries(Object.keys(domain.world.tables).map((t) => [t, world.keyOf(t)]));
  const { passed, checks } = gradeTrial({ task, world, calls, agentMessages, violations, error });
  usage.costUsd = costOf(usage.agent, usage.user);
  return {
    taskId: task.id,
    trial,
    passed,
    checks,
    violations,
    events,
    changes: diffSnapshots(initial, world.snapshot(), keys),
    endReason,
    turns,
    durationMs: Math.round(performance.now() - started),
    usage,
    ...(error ? { error } : {}),
  };
}
