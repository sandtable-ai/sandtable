import { invariantTool, mentions, protectedValues } from "../grade/invariants.ts";
import type { LintReport } from "../grade/lint.ts";
import { agentSystemPrompt, type AgentPromptOptions } from "../sim/prompts.ts";
import type { Domain, Invariant, Task } from "../spec/schema.ts";
import { seedFor } from "../world/store.ts";
import type { TrialResult } from "./episode.ts";

/** One task's part in testing one rule in a run. */
export interface CoverageCell {
  task: string;
  /**
   * The task's spec puts the rule in play, as `lint` reads it (TaskLint.rules): its reference calls the tool the rule
   * checks, or its `called` or `not_called` names it; for never_disclose, the agent is shown a value it must not say
   * in its system prompt or a reference call's result.
   */
  planned: boolean;
  /**
   * Trials of the task in which the rule was checked: the agent called the tool it checks, or for never_disclose, was
   * shown a value it must not say. A checked rule applied to what the agent did; that alone doesn't show the task
   * pushes the agent to break it.
   */
  checked: number;
  /** Trials of the task in which the agent broke the rule at least once: the evidence that the task catches a violation. */
  broken: number;
}

/** Which tasks of a run checked one rule (invariant), and how often the agent broke it. */
export interface RuleCoverage {
  id: string;
  description: string;
  /** The rule's kind: its key in the spec. */
  kind: "before" | "require" | "limit" | "match" | "never" | "never_disclose";
  /** The tool whose calls it checks; absent for never_disclose. */
  tool?: string;
  /** For never_disclose: the `table.field` whose values the agent must never say. */
  field?: string;
  /** Set on a soft rule, which never fails a trial. */
  soft?: true;
  /** The rule's `source` in the spec: the document it was drafted from, and the quote. */
  source?: { file: string; quote?: string };
  /** A cell for each task of the run that planned or checked the rule, in spec order. A task that did neither has none. */
  tasks: CoverageCell[];
  /** Trials that checked it, across the run. */
  checked: number;
  /** Trials that broke it, across the run. */
  broken: number;
}

/** How much a run's agent used one tool. */
export interface ToolCoverage {
  name: string;
  /** Trials in which the agent called it. */
  trials: number;
  /** Its calls across the run. */
  calls: number;
  /** The tasks with a trial that called it, in spec order. */
  tasks: string[];
}

/**
 * What a run checked: for each rule, the tasks whose trials checked it and the trials that broke it, and for each
 * tool, the trials that called it. A rule no trial checked, or a tool no trial called, is a gap: a run that passes
 * says nothing about it. Only a broken rule shows that a task catches a violation of it.
 */
export interface Coverage {
  /** One per invariant of the domain, in spec order. */
  rules: RuleCoverage[];
  /** One per tool of the domain, in spec order. */
  tools: ToolCoverage[];
}

const KINDS = ["before", "require", "limit", "match", "never", "never_disclose"] as const;

/**
 * The coverage of a run's trials of `tasks`, from what they did and the domain's rules, without any model call.
 * `lint` is the domain's lint report, which says which rules each task's spec puts in play.
 */
export function coverageOf(domain: Domain, tasks: readonly Task[], results: readonly TrialResult[], lint: LintReport, prompt: AgentPromptOptions = {}): Coverage {
  const trialsOf = new Map(tasks.map((t) => [t.id, results.filter((r) => r.taskId === t.id)]));
  const planned = new Map(lint.tasks.map((t) => [t.id, new Set(t.rules)]));
  const rules = domain.invariants.map((inv): RuleCoverage => {
    const tool = invariantTool(inv);
    const cells = tasks.flatMap((task) => {
      const trials = trialsOf.get(task.id) ?? [];
      const checks = tool !== undefined ? (tr: TrialResult) => called(tr, tool) : showsProtected(domain, task, inv, prompt);
      const checked = trials.filter(checks).length;
      const broken = trials.filter((tr) => broke(tr, inv.id)).length;
      const isPlanned = planned.get(task.id)?.has(inv.id) ?? false;
      return isPlanned || checked || broken ? [{ task: task.id, planned: isPlanned, checked, broken }] : [];
    });
    return {
      id: inv.id,
      description: inv.description,
      kind: KINDS.find((k) => k in inv)!,
      ...(tool !== undefined ? { tool } : {}),
      ...("never_disclose" in inv ? { field: `${inv.never_disclose.table}.${inv.never_disclose.field}` } : {}),
      ...(inv.soft ? { soft: true as const } : {}),
      ...(inv.source ? { source: inv.source } : {}),
      tasks: cells,
      checked: cells.reduce((n, c) => n + c.checked, 0),
      broken: cells.reduce((n, c) => n + c.broken, 0),
    };
  });
  const tools = domain.tools.map(({ name }): ToolCoverage => {
    const counts = results.map((tr) => tr.events.filter((e) => e.type === "tool" && e.name === name).length);
    return {
      name,
      trials: counts.filter((n) => n > 0).length,
      calls: counts.reduce((n, c) => n + c, 0),
      tasks: tasks.filter((t) => (trialsOf.get(t.id) ?? []).some((tr) => called(tr, name))).map((t) => t.id),
    };
  });
  return { rules, tools };
}

/** The agent called `tool` in this trial, whether or not the call succeeded: a rule is checked on every attempt. */
function called(tr: TrialResult, tool: string): boolean {
  return tr.events.some((e) => e.type === "tool" && e.name === tool);
}

/** The agent broke the rule at least once in this trial, as a hard or a soft violation. */
function broke(tr: TrialResult, id: string): boolean {
  return tr.violations.some((v) => v.invariant === id) || (tr.soft ?? []).some((c) => c.id === id && c.broken);
}

/**
 * Whether a trial showed the agent a value a never_disclose rule protects: in its system prompt (the policy and the
 * task's context) or in a successful tool call's result. The values are those of the task's seed and of the rows the
 * trial wrote, such as an id a tool created.
 */
function showsProtected(domain: Domain, task: Task, inv: Invariant, prompt: AgentPromptOptions): (tr: TrialResult) => boolean {
  if (!("never_disclose" in inv)) return () => false;
  const { table, field } = inv.never_disclose;
  const seeded = [...protectedValues(seedFor(domain, task).tables[table]?.rows ?? [], field)];
  const system = agentSystemPrompt(domain, task, prompt);
  // The system prompt is the same in every trial of the task: shown there, shown in all of them.
  if (seeded.some((v) => mentions(system, v))) return () => true;
  return (tr) => {
    const written = tr.changes.flatMap((c) => (c.table === table && c.after ? [c.after] : []));
    const values = [...new Set([...seeded, ...protectedValues(written, field)])];
    const results = tr.events.flatMap((e) => (e.type === "tool" && e.ok ? [JSON.stringify(e.result) ?? ""] : []));
    return results.some((text) => values.some((v) => mentions(text, v)));
  };
}
