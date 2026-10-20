import { checkCall, type CallRecord, type Violation } from "../grade/invariants.ts";
import type { Domain } from "../spec/schema.ts";
import type { World } from "../world/store.ts";
import { coerceArgs, executeTool, type ToolOutcome } from "../world/tools.ts";

export interface ToolEvent {
  index: number;
  name: string;
  args: unknown;
  outcome: ToolOutcome;
  violations: Violation[];
}

/**
 * Validates, checks and executes tool calls against one world, keeping the call log and
 * invariant violations. Shared by live episodes and by `sandtable lint` reference replays.
 * `violations` holds the hard ones, which fail a trial; `soft` holds soft invariants' violations.
 */
export function createToolRunner(domain: Domain, world: World, onCall?: (e: ToolEvent) => void) {
  const toolsByName = new Map(domain.tools.map((t) => [t.name, t]));
  const calls: CallRecord[] = [];
  const violations: Violation[] = [];
  const soft: Violation[] = [];

  function call(name: string, rawArgs: unknown): ToolOutcome {
    const index = calls.length;
    const tool = toolsByName.get(name);
    const finish = (rec: CallRecord, found: Violation[] = []): ToolOutcome => {
      calls.push(rec);
      for (const v of found) (v.soft ? soft : violations).push(v);
      const outcome = { ok: rec.ok, result: rec.result, error: rec.error };
      onCall?.({ index, name, args: rawArgs, outcome, violations: found });
      return outcome;
    };
    if (!tool) return finish({ index, name, args: {}, ok: false, error: `unknown tool "${name}"` });
    const coerced = coerceArgs(tool, rawArgs);
    if ("error" in coerced) return finish({ index, name, args: {}, ok: false, error: coerced.error });
    const found = checkCall(domain, world, calls, { index, name, args: coerced.args });
    return finish({ index, name, args: coerced.args, ...executeTool(tool, world, coerced.args) }, found);
  }

  return { call, calls, violations, soft };
}

export type ToolRunner = ReturnType<typeof createToolRunner>;
