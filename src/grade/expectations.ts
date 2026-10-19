import type { StateAssert, Task } from "../spec/schema.ts";
import { matches, mismatch } from "../world/match.ts";
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

  for (const name of task.expect.called) {
    const ok = calls.some((c) => c.name === name && c.ok);
    checks.push({
      id: `called:${name}`,
      kind: "called",
      passed: ok,
      detail: ok ? `${name} succeeded` : `${name} was never called successfully`,
    });
  }

  for (const name of task.expect.not_called) {
    const n = calls.filter((c) => c.name === name).length;
    checks.push({
      id: `not_called:${name}`,
      kind: "not_called",
      passed: n === 0,
      detail: n === 0 ? `${name} not called` : `${name} was called ${n}x`,
    });
  }

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
