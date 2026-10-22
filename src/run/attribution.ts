import { callCheckId, expectedTool } from "../grade/expectations.ts";
import type { TaskLint } from "../grade/lint.ts";
import type { Invariant, Task } from "../spec/schema.ts";
import { matches, type Row } from "../world/match.ts";
import type { TrajectoryEvent, TrialResult } from "./episode.ts";

/**
 * Whose fault a trial that didn't pass most likely is, in the words the plugin's attribution guide uses: the agent
 * under test, the simulated user, the task spec (the domain and the task as written), or the harness (adapters,
 * endpoints, credentials, rate limits).
 */
export type Owner = "agent" | "simulated-user" | "task-spec" | "harness";

/** Every owner, in the order reports list them. */
export const OWNERS: readonly Owner[] = ["agent", "simulated-user", "task-spec", "harness"];

/**
 * A first suspect for a trial that didn't pass, from deterministic evidence only: never a model call, and never a
 * reason to change a verdict or a score. Read the transcript before trusting it.
 */
export interface Attribution {
  owner: Owner;
  /** What points at the owner, e.g. the trial's error, lint's finding, a caller note or the first failed check. */
  evidence: string;
}

/** Trials that didn't pass, per owner. */
export type AttributionCounts = Record<Owner, number>;

/**
 * The first suspect for a trial that didn't pass, or undefined for one that passed. The first rule that applies wins:
 * - **harness**: the trial was skipped, since it ended in an error before the agent broke a rule;
 * - **task-spec**: lint proves the task can't pass as written, because a row it expects can't come to exist
 *   (`ready: false`) or its own `reference` fails its expectations (`solvable: false`);
 * - **simulated-user**: a caller note, a turn in which the caller stepped out of its role, comes before the trial's
 *   first hard failure (a hard invariant or a `not_called` tool), or anywhere in a trial that failed only on how it
 *   ended (end state, `called`, `reply`);
 * - **agent**: everything else. This is the default, not a finding: a caller that drifted without stepping out of its
 *   role, or a task that lint can't prove wrong (a rule stricter than the SOP, a seed row that contradicts the
 *   caller's instructions), stays with the agent until someone reads the transcript.
 */
export function attributeTrial(trial: TrialResult, task: Task, lint: TaskLint | undefined, invariants: readonly Invariant[] = []): Attribution | undefined {
  if (trial.passed) return undefined;
  if (trial.skipped) return { owner: "harness", evidence: trial.error ?? "it ended in an error before the agent broke a rule" };
  const unpassable = lint && lintProblem(lint);
  if (unpassable) return { owner: "task-spec", evidence: `lint: ${unpassable}` };
  const failure = firstFailure(trial, task);
  const note = (trial.callerNotes ?? []).find((n) => userTurnAt(trial.events, n.turn) < failure);
  if (note) return { owner: "simulated-user", evidence: `caller turn ${note.turn} (${note.why}): "${note.text}"` };
  // The default owner: say so, so the evidence reads as nothing pointing elsewhere, not as proof.
  const failed = trial.checks.filter((c) => !c.passed);
  const first = failed.find((c) => c.kind !== "runtime") ?? failed[0];
  const evidence = `nothing points at the caller, the task or the harness; first failed check: ${first ? `${first.id}: ${first.detail}` : "none recorded"}`;
  return { owner: "agent", evidence: evidence + (first?.kind === "invariant" ? ruleSource(invariants.find((i) => i.id === first.id)) : "") };
}

/**
 * For a failed rule, what to check it against before the agent is blamed: a rule stricter than the SOP fails a
 * correct agent, and only reading the rule beside its source shows it.
 */
function ruleSource(rule: Invariant | undefined): string {
  if (!rule) return "";
  const quote = rule.source?.quote;
  return quote ? `. Check the rule against its source before blaming the agent: "${quote}"` : ". The rule has no source quote: check it against policy.md before blaming the agent";
}

/** Each owner's count over `trials`, every owner listed. */
export function attributionCounts(trials: readonly Pick<TrialResult, "attribution">[]): AttributionCounts {
  const counts = Object.fromEntries(OWNERS.map((o) => [o, 0])) as AttributionCounts;
  for (const t of trials) if (t.attribution) counts[t.attribution.owner]++;
  return counts;
}

/** Why lint says the task can't pass as written, or undefined when it doesn't say so. */
function lintProblem(lint: TaskLint): string | undefined {
  if (!lint.ready) return lint.errors.find((e) => e.startsWith("expect.state[")) ?? "a row the task expects can't come to exist";
  if (lint.solvable === false) return lint.errors.find((e) => e.startsWith("reference")) ?? "its reference doesn't pass its own expectations";
  return undefined;
}

/**
 * Where in the transcript the trial first failed for good: the first hard invariant violation, or the first call of a
 * tool its `not_called` forbids, as an index into `events`. Infinity when it failed only on how it ended.
 */
function firstFailure(trial: TrialResult, task: Task): number {
  const { events } = trial;
  const at: number[] = [];
  for (const v of trial.violations) {
    if (v.callIndex !== undefined) at.push(events.findIndex((e) => e.type === "tool" && e.index === v.callIndex));
    if (v.messageIndex !== undefined) at.push(nthIndex(events, "agent", v.messageIndex));
  }
  const failed = new Set(trial.checks.filter((c) => !c.passed).map((c) => c.id));
  for (const e of task.expect.not_called) {
    if (!failed.has(callCheckId("not_called", e))) continue;
    const tool = expectedTool(e);
    at.push(events.findIndex((ev) => ev.type === "tool" && ev.name === tool && (typeof e === "string" || matches((ev.args ?? {}) as Row, e.args))));
  }
  const found = at.filter((i) => i >= 0);
  return found.length ? Math.min(...found) : Number.POSITIVE_INFINITY;
}

/** The index in `events` of the caller's turn `turn`, counting from 1, as caller notes do. */
function userTurnAt(events: readonly TrajectoryEvent[], turn: number): number {
  return nthIndex(events, "user", turn - 1);
}

/** The index in `events` of the n-th (from 0) event of `type`, or Infinity when there is none. */
function nthIndex(events: readonly TrajectoryEvent[], type: TrajectoryEvent["type"], n: number): number {
  let seen = 0;
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.type !== type) continue;
    if (seen++ === n) return i;
  }
  return Number.POSITIVE_INFINITY;
}
