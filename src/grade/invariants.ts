import type { Domain, FieldRefSpec, Invariant } from "../spec/schema.ts";
import { equal, matches, mismatch, type Args } from "../world/match.ts";
import type { World } from "../world/store.ts";

export interface CallRecord {
  index: number;
  name: string;
  args: Args;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface Violation {
  invariant: string;
  description: string;
  detail: string;
  callIndex: number;
}

/**
 * Check every invariant against a tool call the agent is about to make,
 * using the world as it is at decision time. Attempting a forbidden action is
 * a violation even if the API would have rejected it afterwards.
 */
export function checkCall(
  domain: Domain,
  world: World,
  history: readonly CallRecord[],
  call: { index: number; name: string; args: Args },
): Violation[] {
  const violations: Violation[] = [];
  for (const inv of domain.invariants) {
    const detail = evaluate(inv, world, history, call);
    if (detail) violations.push({ invariant: inv.id, description: inv.description, detail, callIndex: call.index });
  }
  return violations;
}

function evaluate(
  inv: Invariant,
  world: World,
  history: readonly CallRecord[],
  call: { name: string; args: Args },
): string | undefined {
  if ("before" in inv) {
    const { first, then, same } = inv.before;
    if (call.name !== then) return;
    const ok = history.some((h) => h.name === first && h.ok && same.every((a) => equal(h.args[a], call.args[a])));
    if (ok) return;
    const scope = same.length ? ` for the same ${same.join(", ")}` : "";
    return `${then}(${fmt(call.args)}) was called without a prior successful ${first}${scope}`;
  }
  if ("require" in inv) {
    const { tool, table, key_arg, where } = inv.require;
    if (call.name !== tool) return;
    const key = String(call.args[key_arg]);
    const row = world.get(table, key);
    if (!row) return `${tool} referenced ${table} ${key}, which does not exist`;
    if (!matches(row, where)) return `${tool} on ${table} ${key}: ${mismatch(row, where)}`;
    return;
  }
  if ("limit" in inv) {
    const { tool, arg, lte, gte } = inv.limit;
    if (call.name !== tool) return;
    const value = Number(call.args[arg]);
    const max = lte === undefined ? undefined : bound(lte, world, call.args);
    const min = gte === undefined ? undefined : bound(gte, world, call.args);
    if (max !== undefined && value > max) return `${tool} ${arg}=${value} exceeds the limit ${max}`;
    if (min !== undefined && value < min) return `${tool} ${arg}=${value} is below the limit ${min}`;
    return;
  }
  if ("match" in inv) {
    const { tool, left, right } = inv.match;
    if (call.name !== tool) return;
    const l = field(left, world, call.args);
    const r = field(right, world, call.args);
    if (l === undefined || r === undefined) return;
    if (!equal(l, r)) return `${left.table}.${left.field}=${JSON.stringify(l)} does not match ${right.table}.${right.field}=${JSON.stringify(r)}`;
    return;
  }
  const { tool, when } = inv.never;
  if (call.name !== tool) return;
  if (when && !matches(call.args, when)) return;
  return `${tool}(${fmt(call.args)}) must never be called${when ? " with these arguments" : ""}`;
}

function bound(ref: number | FieldRefSpec, world: World, args: Args): number | undefined {
  if (typeof ref === "number") return ref;
  const v = field(ref, world, args);
  return v === undefined ? undefined : Number(v);
}

function field(ref: FieldRefSpec, world: World, args: Args): unknown {
  return world.get(ref.table, String(args[ref.key_arg]))?.[ref.field];
}

function fmt(args: Args): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
}
