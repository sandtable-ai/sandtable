import { STATUS_CODES } from "node:http";
import { checkCall, type CallRecord, type FaultApplied, type Violation } from "../grade/invariants.ts";
import type { Domain, Fault, Task, TaskEvent } from "../spec/schema.ts";
import { WorldError, type Change, type World } from "../world/store.ts";
import { coerceArgs, executeTool, type ToolOutcome } from "../world/tools.ts";

export interface ToolEvent {
  index: number;
  name: string;
  args: unknown;
  outcome: ToolOutcome;
  violations: Violation[];
  /** What a task's fault did to this call, when one hit it. */
  fault?: FaultApplied;
  /** The changes the task's events made to the world right after this call, when one followed it. */
  eventChanges?: Change[];
}

/**
 * Validates, checks and executes tool calls against one world, keeping the call log and
 * invariant violations. Shared by live episodes and by `sandtable lint` reference replays.
 * `violations` holds the hard ones, which fail a trial; `soft` holds soft invariants' violations.
 * With a task, its `faults` hit the calls they name and its `events` change the world after theirs: both count a tool's
 * calls from 1, leaving out calls with invalid arguments, which never reach the API. `faultsHit` and `eventsFired`
 * hold the indexes of the faults and events that did.
 */
export function createToolRunner(domain: Domain, world: World, onCall?: (e: ToolEvent) => void, task?: Pick<Task, "faults" | "events">) {
  const toolsByName = new Map(domain.tools.map((t) => [t.name, t]));
  const calls: CallRecord[] = [];
  const violations: Violation[] = [];
  const soft: Violation[] = [];
  /** Per tool, the calls that reached it: those with valid arguments. */
  const reached = new Map<string, number>();
  const faultsHit = new Set<number>();
  const eventsFired = new Set<number>();

  function call(name: string, rawArgs: unknown): ToolOutcome {
    const index = calls.length;
    const tool = toolsByName.get(name);
    const finish = (rec: CallRecord, found: Violation[] = [], eventChanges: Change[] = []): ToolOutcome => {
      calls.push(rec);
      for (const v of found) (v.soft ? soft : violations).push(v);
      const outcome = { ok: rec.ok, result: rec.result, error: rec.error };
      onCall?.({ index, name, args: rawArgs, outcome, violations: found, ...(rec.fault ? { fault: rec.fault } : {}), ...(eventChanges.length ? { eventChanges } : {}) });
      return outcome;
    };
    if (!tool) return finish({ index, name, args: {}, ok: false, error: `unknown tool "${name}"` });
    const coerced = coerceArgs(tool, rawArgs);
    if ("error" in coerced) return finish({ index, name, args: {}, ok: false, error: coerced.error });
    const n = (reached.get(name) ?? 0) + 1;
    reached.set(name, n);
    const found = checkCall(domain, world, calls, { index, name, args: coerced.args });
    const at = (task?.faults ?? []).findIndex((f) => f.tool === name && hits(f, n));
    let rec: CallRecord;
    if (at < 0) {
      rec = { index, name, args: coerced.args, ...executeTool(tool, world, coerced.args) };
    } else {
      faultsHit.add(at);
      const fault = task!.faults![at]!;
      const ran = !fault.error || fault.after_commit ? executeTool(tool, world, coerced.args) : undefined;
      const outcome = fault.error ? { ok: false, error: faultMessage(fault, name) } : ran!;
      rec = { index, name, args: coerced.args, ...outcome, fault: applied(fault, fault.after_commit ? ran!.ok : undefined) };
    }
    return finish(rec, found, fire(name, n));
  }

  /** Apply the task's events that follow the `n`-th call of `name`, in spec order, and return what they changed. */
  function fire(name: string, n: number): Change[] {
    const changes: Change[] = [];
    (task?.events ?? []).forEach((e, i) => {
      if (e.after.tool !== name || e.after.call !== n) return;
      eventsFired.add(i);
      // The loader checks that an update's row exists and a created key is new, but the agent may have created that
      // key itself by now: then the event changes nothing.
      try {
        changes.push(applyEvent(world, e));
      } catch (err) {
        if (!(err instanceof WorldError)) throw err;
      }
    });
    return changes;
  }

  return { call, calls, violations, soft, faultsHit, eventsFired };
}

export type ToolRunner = ReturnType<typeof createToolRunner>;

/** Whether a fault hits the `n`-th call of its tool. */
const hits = (f: Fault, n: number) => f.call === undefined || (Array.isArray(f.call) ? f.call.includes(n) : f.call === n);

/** The HTTP status a fault's error stands for: 504 for a timeout, 429 for a rate limit, the 5xx of a server error. */
export function faultStatus(f: Pick<Fault, "error" | "status">): number | undefined {
  if (f.error === "timeout") return 504;
  if (f.error === "rate_limit") return 429;
  if (f.error === "server_error") return f.status ?? 503;
  return undefined;
}

/** The error the agent sees for a fault: its `message`, or what a client would report for that failure. */
function faultMessage(f: Fault, tool: string): string {
  if (f.message) return f.message;
  if (f.error === "timeout") return `${tool} timed out: no response from the server`;
  if (f.error === "rate_limit") {
    const s = f.retry_after ?? 1;
    return `429 Too Many Requests: rate limit exceeded, retry after ${s} second${s === 1 ? "" : "s"}`;
  }
  const status = faultStatus(f)!;
  return `${status} ${STATUS_CODES[status] ?? "Server Error"}: the server could not handle the request`;
}

/** A fault as the trajectory records it. `committed` says, for an after_commit fault, whether the tool's write landed. */
function applied(f: Fault, committed: boolean | undefined): FaultApplied {
  return {
    ...(f.error ? { error: f.error, status: faultStatus(f)! } : {}),
    ...(f.error === "rate_limit" ? { retryAfter: f.retry_after ?? 1 } : {}),
    ...(f.latency_ms !== undefined ? { latencyMs: f.latency_ms } : {}),
    ...(committed !== undefined ? { committed } : {}),
  };
}

/** Make one event's change to the world, with literal values. */
function applyEvent(world: World, e: TaskEvent): Change {
  if ("update" in e) {
    const before = world.get(e.update, e.key);
    const after = world.update(e.update, e.key, e.set);
    return { table: e.update, key: e.key, kind: "update", ...(before ? { before } : {}), after };
  }
  const after = world.insert(e.create, e.values);
  return { table: e.create, key: String(after[world.keyOf(e.create)]), kind: "insert", after };
}
