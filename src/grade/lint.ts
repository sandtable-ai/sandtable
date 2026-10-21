import { createToolRunner } from "../run/tool-runner.ts";
import type { Domain, Task } from "../spec/schema.ts";
import { matches } from "../world/match.ts";
import { worldFor } from "../world/store.ts";
import { expectedTool, gradeTrial } from "./expectations.ts";
import { checkTranscript } from "./invariants.ts";

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
  errors: string[];
  warnings: string[];
}

export interface LintReport {
  tasks: TaskLint[];
  errors: number;
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
  return {
    tasks,
    errors: tasks.reduce((n, t) => n + t.errors.length, 0),
    warnings: tasks.reduce((n, t) => n + t.warnings.length, 0),
  };
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
      errors.push(`expect.state[${i}] needs a ${a.table} row that is not seeded and no tool can create or change`);
    }
  });

  const noop = gradeTrial({ task, world: seed, calls: [], agentMessages: [], violations: [] });
  const noopPasses = noop.passed;
  if (expectsWrite && noopPasses) errors.push("vacuous: the seed already satisfies the expected state, so a do-nothing agent passes");

  let solvable: boolean | null = null;
  if (task.reference) {
    const world = worldFor(domain, task);
    const runner = createToolRunner(domain, world);
    task.reference.forEach((c, i) => {
      const out = runner.call(c.tool, c.args);
      if (!out.ok) errors.push(`reference[${i}] ${c.tool} failed: ${out.error}`);
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

  return { id: task.id, ready, solvable, expectsWrite, noopPasses, errors, warnings };
}
