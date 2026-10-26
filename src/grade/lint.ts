import { createToolRunner } from "../run/tool-runner.ts";
import { agentSystemPrompt } from "../sim/prompts.ts";
import type { Domain, Invariant, ReferenceCall, Task } from "../spec/schema.ts";
import { matches } from "../world/match.ts";
import { worldFor, type World } from "../world/store.ts";
import { coerceArgs } from "../world/tools.ts";
import { expectedTool, gradeTrial } from "./expectations.ts";
import { checkTranscript, invariantTool, mentions, protectedValues, type CallRecord } from "./invariants.ts";

export interface TaskLint {
  id: string;
  /** Every row the expectations need exists, or some tool can create or change it. */
  ready: boolean;
  /** true: the reference replay passes; false: it fails; null: no reference to replay. */
  solvable: boolean | null;
  /** The task expects something to change (a write); refusal tasks do not. */
  expectsWrite: boolean;
  /** A do-nothing agent passes this task. */
  noopPasses: boolean;
  /**
   * The rules (invariant ids) this task puts in play, in spec order: its reference calls the tool a rule
   * checks, or its `called` or `not_called` names that tool. A never_disclose rule is in play when the
   * agent is shown a value it must not say: in its system prompt (the policy and the task's context) or in the
   * result of a successful reference call.
   */
  rules: string[];
  errors: string[];
  warnings: string[];
}

/**
 * Which tasks put one rule (invariant) in play, read from the spec without any model call. A rule in play is checked
 * whenever the agent acts; only a run in which an agent breaks it shows that a task catches a violation.
 */
export interface RuleLint {
  id: string;
  /** The tasks whose `rules` include it, in spec order. */
  tasks: string[];
  /** One when no task puts it in play: a run that passes says nothing about it. */
  warnings: string[];
}

export interface LintReport {
  tasks: TaskLint[];
  /** One per invariant, in spec order. */
  rules: RuleLint[];
  /** Tools no task's reference calls and no `called` or `not_called` names, in spec order. A note, not a warning: an agent may never need a tool. */
  unusedTools: string[];
  /** Errors in tasks: any one fails `lint`. */
  errors: number;
  /** Warnings in tasks and rules: they never fail `lint`. */
  warnings: number;
}

/**
 * Prove each task is worth grading, without any model call:
 * ready (reachable rows), solvable (reference replay passes), non-vacuous (a do-nothing
 * agent fails tasks that expect a write) and discriminating (something is graded at all).
 */
export function lintDomain(domain: Domain): LintReport {
  const changeable = new Set<string>();
  const writers = new Set<string>();
  for (const tool of domain.tools) {
    for (const op of tool.ops) {
      if ("create" in op) changeable.add(op.create);
      if ("update" in op) changeable.add(op.update);
      if ("create" in op || "update" in op) writers.add(tool.name);
    }
  }
  const tasks = domain.tasks.map((task) => lintTask(domain, task, changeable, writers));
  const rules = domain.invariants.map((inv) => {
    const ids = tasks.filter((t) => t.rules.includes(inv.id)).map((t) => t.id);
    return { id: inv.id, tasks: ids, warnings: ids.length ? [] : [unchecked(inv)] };
  });
  const used = new Set(domain.tasks.flatMap(toolsNamed));
  return {
    tasks,
    rules,
    unusedTools: domain.tools.map((t) => t.name).filter((name) => !used.has(name)),
    errors: tasks.reduce((n, t) => n + t.errors.length, 0),
    warnings: [...tasks, ...rules].reduce((n, t) => n + t.warnings.length, 0),
  };
}

/** The tools a task's reference calls or its `called` and `not_called` name. */
function toolsNamed(task: Task): string[] {
  return [...(task.reference ?? []).map((c) => c.tool), ...[...task.expect.called, ...task.expect.not_called].map(expectedTool)];
}

/** Why a rule no task checks gets a warning, and what would put it in play. */
function unchecked(inv: Invariant): string {
  if ("never_disclose" in inv) {
    const { table, field } = inv.never_disclose;
    return `no task checks it: no task's reference or context shows the agent a ${table}.${field} value. Add a reference to a task in which the agent looks one up`;
  }
  const tool = invariantTool(inv)!;
  return `no task checks it: no task's reference calls ${tool}, and no task's called or not_called names it. Add a task in which the agent has reason to call ${tool}`;
}

/**
 * The rules a task puts in play (see TaskLint.rules). `worlds` hold the values a never_disclose rule protects:
 * the seed, and the world after the reference replay, which has the rows its calls created. What the agent is shown
 * is its system prompt, then the results of the reference's successful calls.
 */
function rulesInPlay(domain: Domain, task: Task, worlds: readonly World[], calls: readonly CallRecord[]): string[] {
  const used = new Set(toolsNamed(task));
  const shown = [agentSystemPrompt(domain, task), ...calls.filter((c) => c.ok).map((c) => JSON.stringify(c.result) ?? "")];
  return domain.invariants
    .filter((inv) => {
      if (!("never_disclose" in inv)) return used.has(invariantTool(inv)!);
      const { table, field } = inv.never_disclose;
      const values = new Set(worlds.flatMap((w) => [...protectedValues(w.list(table), field)]));
      return shown.some((text) => [...values].some((v) => mentions(text, v)));
    })
    .map((inv) => inv.id);
}

function lintTask(domain: Domain, task: Task, changeable: Set<string>, writers: Set<string>): TaskLint {
  const errors: string[] = [];
  const warnings: string[] = [];
  // The world the task starts in: the domain's seed with the task's `given.rows` merged in.
  const seed = worldFor(domain, task);
  // A write is expected when rows must come to exist (a `where` with a positive count) or a writing
  // tool must be called. `key` + `fields` assertions often check that something did NOT change.
  const expectsWrite =
    task.expect.state.some((a) => a.key === undefined && (a.count === undefined || a.count > 0)) ||
    task.expect.called.some((e) => writers.has(expectedTool(e)));

  if (!task.expect.state.length && !task.expect.called.length) {
    errors.push("nothing is graded: add state or called expectations");
  }

  let ready = true;
  task.expect.state.forEach((a, i) => {
    if (a.count === 0) return;
    const present = a.key !== undefined ? seed.get(a.table, a.key) !== undefined : seed.list(a.table).some((r) => matches(r, a.where ?? {}));
    if (!present && !changeable.has(a.table)) {
      ready = false;
      errors.push(`expect.state[${i}] needs a row in ${a.table} that is not seeded and no tool can create or change`);
    }
  });

  const noop = gradeTrial({ task, world: seed, calls: [], agentMessages: [], violations: [] });
  const noopPasses = noop.passed;
  if (expectsWrite && noopPasses) errors.push("vacuous: the seed already satisfies the expected state, so a do-nothing agent passes");

  let solvable: boolean | null = null;
  const worlds = [seed];
  let replayed: readonly CallRecord[] = [];
  if (task.reference) {
    const world = worldFor(domain, task);
    const runner = createToolRunner(domain, world);
    worlds.push(world);
    replayed = runner.calls;
    task.reference.forEach((c, i) => {
      const problem = referenceProblem(domain, c);
      if (problem) {
        errors.push(`reference[${i}] ${c.tool}: ${problem}`);
        return;
      }
      const out = runner.call(c.tool, c.args);
      if (c.expect_error === undefined || c.expect_error === false) {
        if (!out.ok) errors.push(`reference[${i}] ${c.tool} failed: ${out.error}`);
      } else if (out.ok) {
        errors.push(`reference[${i}] ${c.tool} succeeded, but its expect_error says the API rejects it`);
      } else if (typeof c.expect_error === "string" && !(out.error ?? "").toLowerCase().includes(c.expect_error.toLowerCase())) {
        errors.push(`reference[${i}] ${c.tool} failed with "${out.error}", but its expect_error wants an error containing "${c.expect_error}"`);
      }
    });
    // Soft invariants never fail a trial, so they never make a task unsolvable either.
    const violations = [...runner.violations, ...checkTranscript(domain, world, runner.calls, []).filter((v) => !v.soft)];
    const graded = gradeTrial({ task, world, calls: runner.calls, agentMessages: [], violations });
    const failing = graded.checks.filter((c) => !c.passed && c.kind !== "reply");
    for (const c of failing) errors.push(`reference does not pass: ${c.id}: ${c.detail}`);
    solvable = failing.length === 0 && !errors.some((e) => e.startsWith("reference["));
  } else if (expectsWrite) {
    warnings.push("no reference: add the tool calls a correct agent would make to prove the task is solvable");
  }

  return { id: task.id, ready, solvable, expectsWrite, noopPasses, rules: rulesInPlay(domain, task, worlds, replayed), errors, warnings };
}

/**
 * Why a reference call is wrong in itself, before it runs: an unknown tool, or arguments the tool rejects
 * (a missing or misspelled one, a wrong type). Such a call fails at validation, not where the API would
 * reject it, so it never counts as the error `expect_error` expects.
 */
function referenceProblem(domain: Domain, call: ReferenceCall): string | undefined {
  const tool = domain.tools.find((t) => t.name === call.tool);
  if (!tool) return `unknown tool "${call.tool}"`;
  const coerced = coerceArgs(tool, call.args);
  return "error" in coerced ? `invalid arguments: ${coerced.error}` : undefined;
}
