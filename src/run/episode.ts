import { gradeTrial, type CheckResult } from "../grade/expectations.ts";
import { checkTranscript, type Violation } from "../grade/invariants.ts";
import type { Domain, Task } from "../spec/schema.ts";
import { agentSystemPrompt } from "../sim/prompts.ts";
import type { AgentAdapter, CallTool, UserSimulator } from "../sim/types.ts";
import { diffSnapshots, World, type Change } from "../world/store.ts";
import { toolSchema } from "../world/tools.ts";
import { createToolRunner } from "./tool-runner.ts";
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
  const agentMessages: string[] = [];
  const usage: Usage = { agent: {}, user: {}, costUsd: 0 };
  const runner = createToolRunner(domain, world, (e) =>
    events.push({ type: "tool", index: e.index, name: e.name, args: e.args, ...e.outcome, violations: e.violations.map((v) => v.invariant) }),
  );
  const callTool: CallTool = async (name, rawArgs) => runner.call(name, rawArgs);

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
        // A closing message with content ("Fine, book it. Bye.") still gets one final agent turn:
        // the caller may have just accepted something the agent must act on.
        if (turn.stop && !turn.text) {
          endReason = "user_stop";
          break;
        }
        const turnStarted = performance.now();
        const reply = await session.reply(turn.text, callTool);
        events.push({ type: "agent", text: reply, latencyMs: Math.round(performance.now() - turnStarted) });
        agentMessages.push(reply);
        turns++;
        if (turn.stop) {
          endReason = "user_stop";
          break;
        }
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
  const violations: Violation[] = [...runner.violations, ...checkTranscript(domain, world, runner.calls, agentMessages)];
  const { passed, checks } = gradeTrial({ task, world, calls: runner.calls, agentMessages, violations, error });
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
