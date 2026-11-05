import type { AgentPromptOptions } from "../sim/prompts.ts";
import { isClockTime, resolveDates, writtenClock } from "../spec/clock.ts";
import type { Domain, Task } from "../spec/schema.ts";
import { worldFor } from "../world/store.ts";
import type { ToolOutcome } from "../world/tools.ts";
import { gradeEpisode, toolEvent, worldChanges, type TrajectoryEvent, type TrialResult } from "./episode.ts";
import { inputsFingerprint } from "./inputs.ts";
import { runPendingReview, summarize, trialStatus, type SuiteResult } from "./suite.ts";
import { createToolRunner } from "./tool-runner.ts";
import { version } from "../version.ts";

/** A stored run that can't be re-scored under the domain as it is now. */
export class RegradeError extends Error {}

const outcomeOf = (o: ToolOutcome) => JSON.stringify({ ok: o.ok, result: o.result, error: o.error });

/** How a stored run's agent was prompted: without the policy when `run --without-policy` wrote it. */
const promptOf = (stored: Pick<SuiteResult, "withoutPolicy">): AgentPromptOptions => (stored.withoutPolicy ? { withoutPolicy: true } : {});

/**
 * The clock a stored trial's dates resolve at again: the one it recorded, else its task's fixed clock. Undefined when
 * the task has no clock. A trial of a `clock: now` task that recorded none can't be resolved: see noClockFor.
 */
function regradeClock(domain: Domain, task: Task, trial: Pick<TrialResult, "clock">): string | undefined {
  const written = writtenClock(domain, task);
  if (written === undefined) return undefined;
  if (trial.clock !== undefined) return trial.clock;
  if (written === "now") throw new RegradeError(noClockFor(task.id));
  return written;
}

const noClockFor = (taskId: string) =>
  `task ${taskId}'s clock is now, and its trials record no clock: there is no telling what the time was when they ran, so their dates can't be resolved again`;

/**
 * Re-score one stored trial under the domain's current invariants and expectations, without calling a
 * model: replay its tool calls in order against a fresh world for its task, then grade the conversation as
 * a live run would. The transcript, usage and timing stay as recorded, and so does the trial's clock: its dates
 * resolve at the minute it recorded, whatever the time is now. Throws a RegradeError when a call now
 * returns something other than what the agent saw, since the rest of the conversation could have gone otherwise.
 */
export function regradeTrial(written: Domain, trial: TrialResult, prompt: AgentPromptOptions = {}): TrialResult {
  const writtenTask = written.tasks.find((t) => t.id === trial.taskId);
  if (!writtenTask) throw new RegradeError(`task ${trial.taskId} is not in ${written.name}`);
  const clock = regradeClock(written, writtenTask, trial);
  const { domain, task, phrases } = clock === undefined ? { domain: written, task: writtenTask, phrases: undefined } : resolveDates(written, writtenTask, clock);
  const world = worldFor(domain, task);
  const initial = world.snapshot();
  const events: TrajectoryEvent[] = [];
  const runner = createToolRunner(domain, world, (e) => events.push(toolEvent(e)), task);
  for (const e of trial.events) {
    if (e.type !== "tool") {
      events.push(e);
      continue;
    }
    if (outcomeOf(runner.call(e.name, e.args, e.via)) !== outcomeOf(e)) {
      throw new RegradeError(`${trial.taskId} trial ${trial.trial + 1}: tool call ${e.index + 1} (${e.name}) now returns something other than what the agent saw`);
    }
  }
  const agentMessages = events.flatMap((e) => (e.type === "agent" ? [e.text] : []));
  // Whether it was skipped is decided again under the current rules, like whether it passed, and so are the caller notes.
  const { skipped: _, callerNotes: __, ...stored } = trial;
  return {
    ...stored,
    ...(clock !== undefined ? { clock } : {}),
    ...gradeEpisode({ domain, task, world, runner, events, agentMessages, prompt, ...(phrases ? { phrases } : {}), ...(trial.error !== undefined ? { error: trial.error } : {}) }),
    events,
    changes: worldChanges(domain, initial, world),
  };
}

/**
 * Why a stored run can't be re-scored under `domain`, or undefined when it can: it must be a run of this
 * domain, its tasks must still exist, the agent and the caller must be given the same prompts now
 * (seed records and tool behaviour are checked call by call, as each trial is replayed), and the trials of a task
 * with `clock: now` must have recorded the clock they ran at.
 */
export function regradeBlocker(domain: Domain, stored: SuiteResult): string | undefined {
  if (stored.domain !== domain.name) return `it is a run of ${stored.domain}, not ${domain.name}`;
  const gone = stored.tasks.map((t) => t.id).filter((id) => !domain.tasks.some((t) => t.id === id));
  if (gone.length) return `${gone.length === 1 ? "task" : "tasks"} ${gone.join(", ")} ${gone.length === 1 ? "is" : "are"} no longer in the domain`;
  if (!stored.inputs) return "it was written by an older sandtable and records no inputs fingerprint, so nothing shows the agent and the caller would be given the same prompts";
  if (stored.inputs !== inputsFingerprint(domain, stored.tasks.map((t) => t.id), stored.user, promptOf(stored))) {
    return "the agent or the caller would be given something else now: the policy, a tool's schema, the clock, or a task's caller prompt, opening, script or turn limit changed since it ran";
  }
  const unclocked = stored.tasks.find((s) => {
    const task = domain.tasks.find((t) => t.id === s.id)!;
    return writtenClock(domain, task) === "now" && s.trials.some((tr) => tr.clock === undefined);
  });
  if (unclocked) return noClockFor(unclocked.id);
  // A recorded clock is one sandtable wrote; anything else is a file edited by hand.
  for (const s of stored.tasks) {
    const bad = s.trials.find((tr) => tr.clock !== undefined && !isClockTime(tr.clock));
    if (bad) return `trial ${bad.trial} of task ${s.id} records the clock ${JSON.stringify(bad.clock)}, which isn't a date and time such as 2026-11-02T09:00, so its dates can't be resolved again`;
  }
  return undefined;
}

/** The trials whose status (passed, failed or skipped) differs between `before` and `after`, as both had them. */
export function changedVerdicts(before: SuiteResult, after: SuiteResult): { before: TrialResult; after: TrialResult }[] {
  const was = new Map(before.tasks.flatMap((t) => t.trials.map((tr) => [`${tr.taskId}#${tr.trial}`, tr] as const)));
  return after.tasks.flatMap((t) =>
    t.trials.flatMap((tr) => {
      const old = was.get(`${tr.taskId}#${tr.trial}`);
      return old && trialStatus(old) !== trialStatus(tr) ? [{ before: old, after: tr }] : [];
    }),
  );
}

/**
 * Re-score every trial of a stored run under the domain's current rules, without calling a model, and
 * recompute the scores. Throws a RegradeError when the run can't be re-scored (see regradeBlocker).
 */
export function regradeSuite(domain: Domain, stored: SuiteResult): SuiteResult {
  const blocker = regradeBlocker(domain, stored);
  if (blocker) throw new RegradeError(blocker);
  const tasks = stored.tasks.map((s) => domain.tasks.find((t) => t.id === s.id)!);
  const prompt = promptOf(stored);
  const trials = stored.tasks.flatMap((s) => s.trials.map((trial) => regradeTrial(domain, trial, prompt)));
  return {
    ...stored,
    sandtable: { ...stored.sandtable, regradedWith: version },
    ...summarize(domain, tasks, trials, stored.k, stored.user, prompt),
    pendingReview: runPendingReview(domain),
  };
}
