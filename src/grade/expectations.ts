import type { CallExpect, StateAssert, Task } from "../spec/schema.ts";
import { matches, mismatch, type Row } from "../world/match.ts";
import type { World } from "../world/store.ts";
import { asciiHyphens, type CallRecord, type Violation } from "./invariants.ts";

export type CheckKind = "invariant" | "state" | "called" | "not_called" | "reply" | "runtime";

export interface CheckResult {
  id: string;
  kind: CheckKind;
  passed: boolean;
  detail: string;
}

/**
 * Deterministic grading: a trial passes only if the world ended in the expected state,
 * the required tools ran, the forbidden ones did not, and no invariant was violated.
 */
export function gradeTrial(input: {
  task: Task;
  world: World;
  calls: readonly CallRecord[];
  agentMessages: readonly string[];
  violations: readonly Violation[];
  error?: string;
}): { passed: boolean; checks: CheckResult[] } {
  const { task, world, calls, agentMessages, violations, error } = input;
  const checks: CheckResult[] = [];

  if (error) checks.push({ id: "runtime", kind: "runtime", passed: false, detail: error });

  for (const v of violations) {
    checks.push({ id: v.invariant, kind: "invariant", passed: false, detail: v.detail });
  }

  task.expect.state.forEach((a, i) => checks.push(checkState(a, i, world)));

  for (const e of task.expect.called) checks.push(checkCalled(e, calls));
  for (const e of task.expect.not_called) checks.push(checkNotCalled(e, calls));

  for (const phrase of task.expect.reply_includes) {
    const ok = agentMessages.some((m) => asciiHyphens(m).toLowerCase().includes(asciiHyphens(phrase).toLowerCase()));
    checks.push({
      id: `reply:${phrase}`,
      kind: "reply",
      passed: ok,
      detail: ok ? `agent said "${phrase}"` : `agent never said "${phrase}"`,
    });
  }

  return { passed: checks.every((c) => c.passed), checks };
}

/** The tool a `called` or `not_called` entry names. */
export function expectedTool(e: CallExpect): string {
  return typeof e === "string" ? e : e.tool;
}

/**
 * The check id of a `called` or `not_called` entry: `called:<tool>` for a name, and for `{ tool, args }`
 * each condition in spec order as `field=<JSON>`, e.g. `called:transfer_to_human(reason="billing")`.
 */
export function callCheckId(kind: "called" | "not_called", e: CallExpect): string {
  if (typeof e === "string") return `${kind}:${e}`;
  return `${kind}:${e.tool}(${Object.entries(e.args).map(([field, cond]) => `${field}=${JSON.stringify(cond)}`).join(", ")})`;
}

function checkCalled(e: CallExpect, calls: readonly CallRecord[]): CheckResult {
  const id = callCheckId("called", e);
  const tool = expectedTool(e);
  const ok = calls.filter((c) => c.name === tool && c.ok);
  if (typeof e === "string") {
    const passed = ok.length > 0;
    return { id, kind: "called", passed, detail: passed ? `${tool} succeeded` : `${tool} was never called successfully` };
  }
  if (ok.some((c) => matches(c.args, e.args))) return { id, kind: "called", passed: true, detail: `${tool} succeeded with matching arguments` };
  const failed = calls.filter((c) => c.name === tool && !c.ok && matches(c.args, e.args)).length;
  const detail =
    ok.length > 0
      ? `${tool} succeeded ${ok.length}x, never with matching arguments: ${closestMismatch(ok, e.args)}`
      : failed > 0
        ? `${tool} was called ${failed}x with matching arguments but never succeeded`
        : `${tool} was never called successfully`;
  return { id, kind: "called", passed: false, detail };
}

function checkNotCalled(e: CallExpect, calls: readonly CallRecord[]): CheckResult {
  const id = callCheckId("not_called", e);
  const tool = expectedTool(e);
  if (typeof e === "string") {
    const n = calls.filter((c) => c.name === tool).length;
    return { id, kind: "not_called", passed: n === 0, detail: n === 0 ? `${tool} not called` : `${tool} was called ${n}x` };
  }
  const n = calls.filter((c) => c.name === tool && matches(c.args, e.args)).length;
  return {
    id,
    kind: "not_called",
    passed: n === 0,
    detail: n === 0 ? `${tool} not called with matching arguments` : `${tool} was called ${n}x with matching arguments`,
  };
}

/** The first failing condition of the call that fails the fewest, the earliest on a tie. */
function closestMismatch(calls: readonly CallRecord[], args: Row): string {
  const failing = (c: CallRecord) => Object.entries(args).filter(([field, cond]) => !matches(c.args, { [field]: cond })).length;
  const closest = calls.reduce((best, c) => (failing(c) < failing(best) ? c : best));
  return mismatch(closest.args, args) ?? "";
}

/**
 * A trial that ended in an error, such as a rate limit or timeout that outlasted the adapter's retries or an
 * agent endpoint that went down, is skipped: the conversation never finished, so it says nothing about the
 * agent, and it is left out of pass^k. Unless the agent had already broken something that finishing the
 * conversation could not undo, a hard invariant or a tool it must not call: then the trial failed like any
 * other, so an agent that crashes can't hide what it broke before the crash.
 */
export function isSkipped(checks: readonly CheckResult[], error: string | undefined): boolean {
  return error !== undefined && !checks.some((c) => !c.passed && (c.kind === "invariant" || c.kind === "not_called"));
}

function checkState(a: StateAssert, i: number, world: World): CheckResult {
  const id = `state:${a.table}${a.key ? `[${a.key}]` : ""}#${i + 1}`;
  if (a.key !== undefined) {
    const row = world.get(a.table, a.key);
    if (a.count === 0) {
      return { id, kind: "state", passed: !row, detail: row ? `${a.table} ${a.key} exists but should not` : `${a.table} ${a.key} absent` };
    }
    if (!row) return { id, kind: "state", passed: false, detail: `${a.table} ${a.key} not found` };
    const why = a.fields ? mismatch(row, a.fields) : undefined;
    return { id, kind: "state", passed: !why, detail: why ? `${a.table} ${a.key}: ${why}` : `${a.table} ${a.key} as expected` };
  }
  const rows = world.list(a.table).filter((r) => matches(r, a.where ?? {}));
  const passed = a.count === undefined ? rows.length >= 1 : rows.length === a.count;
  const expected = a.count === undefined ? "at least 1" : String(a.count);
  return {
    id,
    kind: "state",
    passed,
    detail: `${rows.length} ${a.table} row(s) match ${JSON.stringify(a.where ?? {})} (expected ${expected})`,
  };
}
