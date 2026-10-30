import type { AgentPromptOptions } from "../sim/prompts.ts";
import { pendingReview } from "../spec/load.ts";
import type { Domain } from "../spec/schema.ts";
import { worldFor } from "../world/store.ts";
import type { ToolOutcome } from "../world/tools.ts";
import { gradeEpisode, toolEvent, worldChanges, type TrajectoryEvent, type TrialResult } from "./episode.ts";
import { inputsFingerprint } from "./inputs.ts";
import { summarize, trialStatus, type SuiteResult } from "./suite.ts";
import { createToolRunner } from "./tool-runner.ts";
import { version } from "../version.ts";

/** A stored run that can't be re-scored under the domain as it is now. */
export class RegradeError extends Error {}

const outcomeOf = (o: ToolOutcome) => JSON.stringify({ ok: o.ok, result: o.result, error: o.error });

/** How a stored run's agent was prompted: without the policy when `run --without-policy` wrote it. */
const promptOf = (stored: Pick<SuiteResult, "withoutPolicy">): AgentPromptOptions => (stored.withoutPolicy ? { withoutPolicy: true } : {});

/**
 * Re-score one stored trial under the domain's current invariants and expectations, without calling a
 * model: replay its tool calls in order against a fresh world for its task, then grade the conversation as
 * a live run would. The transcript, usage and timing stay as recorded. Throws a RegradeError when a call now
 * returns something other than what the agent saw, since the rest of the conversation could have gone otherwise.
 */
export function regradeTrial(domain: Domain, trial: TrialResult, prompt: AgentPromptOptions = {}): TrialResult {
  const task = domain.tasks.find((t) => t.id === trial.taskId);
  if (!task) throw new RegradeError(`task ${trial.taskId} is not in ${domain.name}`);
  const world = worldFor(domain, task);
  const initial = world.snapshot();
  const events: TrajectoryEvent[] = [];
  const runner = createToolRunner(domain, world, (e) => events.push(toolEvent(e)), task);
  for (const e of trial.events) {
    if (e.type !== "tool") {
      events.push(e);
      continue;
    }
    if (outcomeOf(runner.call(e.name, e.args)) !== outcomeOf(e)) {
      throw new RegradeError(`${trial.taskId} trial ${trial.trial + 1}: tool call ${e.index + 1} (${e.name}) now returns something other than what the agent saw`);
    }
  }
  const agentMessages = events.flatMap((e) => (e.type === "agent" ? [e.text] : []));
  // Whether it was skipped is decided again under the current rules, like whether it passed, and so are the caller notes.
  const { skipped: _, callerNotes: __, ...stored } = trial;
  return {
    ...stored,
    ...gradeEpisode({ domain, task, world, runner, events, agentMessages, prompt, ...(trial.error !== undefined ? { error: trial.error } : {}) }),
    events,
    changes: worldChanges(domain, initial, world),
  };
}

/**
 * Why a stored run can't be re-scored under `domain`, or undefined when it can: it must be a run of this
 * domain, its tasks must still exist, and the agent and the caller must be given the same prompts now
 * (seed records and tool behaviour are checked call by call, as each trial is replayed).
 */
export function regradeBlocker(domain: Domain, stored: SuiteResult): string | undefined {
  if (stored.domain !== domain.name) return `it is a run of ${stored.domain}, not ${domain.name}`;
  const gone = stored.tasks.map((t) => t.id).filter((id) => !domain.tasks.some((t) => t.id === id));
  if (gone.length) return `${gone.length === 1 ? "task" : "tasks"} ${gone.join(", ")} ${gone.length === 1 ? "is" : "are"} no longer in the domain`;
  if (!stored.inputs) return "it was written by an older sandtable and records no inputs fingerprint, so nothing shows the agent and the caller would be given the same prompts";
  if (stored.inputs !== inputsFingerprint(domain, stored.tasks.map((t) => t.id), stored.user, promptOf(stored))) {
    return "the agent or the caller would be given something else now: the policy, a tool's schema, or a task's caller prompt, opening, script or turn limit changed since it ran";
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
    pendingReview: pendingReview(domain),
  };
}
