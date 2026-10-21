import { gradeTrial, isSkipped, type CheckResult } from "../grade/expectations.ts";
import { checkTranscript, invariantTool, type CallRecord, type Violation } from "../grade/invariants.ts";
import type { Domain, Task } from "../spec/schema.ts";
import { agentSystemPrompt, taskContext } from "../sim/prompts.ts";
import type { AgentAdapter, CallTool, UserSimulator } from "../sim/types.ts";
import { diffSnapshots, worldFor, type Change, type Snapshot, type World } from "../world/store.ts";
import { toolSchema } from "../world/tools.ts";
import { callerNotes, type CallerNote } from "./caller-notes.ts";
import { createToolRunner, type ToolEvent, type ToolRunner } from "./tool-runner.ts";
import { costOf, recordInto, type Usage } from "./usage.ts";

export type TrajectoryEvent =
  | { type: "user"; text: string }
  | { type: "agent"; text: string; latencyMs: number }
  | {
      type: "tool";
      index: number;
      name: string;
      args: unknown;
      ok: boolean;
      result?: unknown;
      error?: string;
      /** Hard invariants this call broke. */
      violations: string[];
      /** Soft invariants this call broke; present only when there are some. */
      soft?: string[];
    };

export type EndReason = "user_stop" | "max_turns" | "error";

/** A soft invariant that applied in a trial, and whether the agent broke it. Never affects `passed`. */
export interface SoftCheck {
  id: string;
  /** Broken at least once in this trial. */
  broken: boolean;
  /** Each time it was broken, with the call or message that broke it. */
  violations: Violation[];
}

export interface TrialResult {
  taskId: string;
  trial: number;
  /** False for a skipped trial too: only a graded trial can pass. */
  passed: boolean;
  /**
   * Present when the trial ended in an error before the agent broke a hard invariant or called a tool it must
   * not call: it was not graded, and pass^k and pass@k leave it out. See isSkipped.
   */
  skipped?: true;
  checks: CheckResult[];
  /** Hard invariant violations: any one fails the trial. */
  violations: Violation[];
  /** Soft invariants that applied (their tool was called; for never_disclose, the agent spoke). */
  soft: SoftCheck[];
  /**
   * Caller turns in which the simulated user stepped out of its role, e.g. talked about its instructions.
   * Present only when there are some, and never a reason to fail: read the trial before trusting its verdict.
   */
  callerNotes?: CallerNote[];
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
  /** Unique per suite run, so session ids never collide across runs. */
  runId?: string;
}): Promise<TrialResult> {
  const { domain, task, agent, user, trial } = input;
  const started = performance.now();
  const world = worldFor(domain, task);
  const initial = world.snapshot();
  const events: TrajectoryEvent[] = [];
  const agentMessages: string[] = [];
  const usage: Usage = { agent: {}, user: {}, costUsd: 0 };
  const runner = createToolRunner(domain, world, (e) => events.push(toolEvent(e)));
  const callTool: CallTool = async (name, rawArgs) => runner.call(name, rawArgs);

  const persona = domain.personas.find((p) => p.id === task.persona);
  const context = taskContext(task);
  const maxTurns = task.max_turns ?? domain.max_turns;
  let endReason: EndReason = "max_turns";
  let turns = 0;
  let error: string | undefined;

  try {
    const session = await agent.createSession({
      domain,
      system: agentSystemPrompt(domain, task),
      tools: domain.tools.map(toolSchema),
      sessionId: `${input.runId ? `${input.runId}/` : ""}${task.id}#${trial}`,
      ...(context ? { context } : {}),
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

  usage.costUsd = costOf(usage.agent, usage.user);
  return {
    taskId: task.id,
    trial,
    ...gradeEpisode({ domain, task, world, runner, events, agentMessages, error }),
    events,
    changes: worldChanges(domain, initial, world),
    endReason,
    turns,
    durationMs: Math.round(performance.now() - started),
    usage,
    ...(error ? { error } : {}),
  };
}

/** A tool call as the trajectory records it, with the invariants it broke. */
export function toolEvent(e: ToolEvent): TrajectoryEvent {
  const soft = e.violations.filter((v) => v.soft).map((v) => v.invariant);
  const hard = e.violations.filter((v) => !v.soft).map((v) => v.invariant);
  return { type: "tool", index: e.index, name: e.name, args: e.args, ...e.outcome, violations: hard, ...(soft.length ? { soft } : {}) };
}

/**
 * Grade a finished conversation: invariants on what the agent said, then the task's expectations on
 * the end state and the tool log. Live runs and `sandtable regrade` both grade through here. The caller
 * notes are found here too, from the transcript alone, and never change the verdict.
 */
export function gradeEpisode(input: {
  domain: Domain;
  task: Task;
  world: World;
  runner: ToolRunner;
  events: readonly TrajectoryEvent[];
  agentMessages: readonly string[];
  error?: string;
}): Pick<TrialResult, "passed" | "skipped" | "checks" | "violations" | "soft" | "callerNotes"> {
  const { domain, task, world, runner, events, agentMessages, error } = input;
  const said = checkTranscript(domain, world, runner.calls, events, agentSystemPrompt(domain, task));
  const violations: Violation[] = [...runner.violations, ...said.filter((v) => !v.soft)];
  const soft = softChecks(domain, runner.calls, agentMessages.length, [...runner.soft, ...said.filter((v) => v.soft)]);
  const { passed, checks } = gradeTrial({ task, world, calls: runner.calls, agentMessages, violations, error });
  const notes = callerNotes(events);
  return { passed, ...(isSkipped(checks, error) ? { skipped: true as const } : {}), checks, violations, soft, ...(notes.length ? { callerNotes: notes } : {}) };
}

/** What a trial changed in the world, row by row. */
export function worldChanges(domain: Domain, initial: Snapshot, world: World): Change[] {
  const keys = Object.fromEntries(Object.keys(domain.world.tables).map((t) => [t, world.keyOf(t)]));
  return diffSnapshots(initial, world.snapshot(), keys);
}

/** One entry per soft invariant that applied in the trial: its tool was called, or for never_disclose, the agent spoke. */
export function softChecks(domain: Domain, calls: readonly CallRecord[], agentMessages: number, found: readonly Violation[]): SoftCheck[] {
  return domain.invariants
    .filter((inv) => inv.soft)
    .flatMap((inv) => {
      const tool = invariantTool(inv);
      const applied = tool === undefined ? agentMessages > 0 : calls.some((c) => c.name === tool);
      const violations = found.filter((v) => v.invariant === inv.id);
      return applied || violations.length ? [{ id: inv.id, broken: violations.length > 0, violations }] : [];
    });
}
