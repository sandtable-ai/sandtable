import { createHash } from "node:crypto";
import type { Domain, Task } from "../spec/schema.ts";
import { agentSystemPrompt, taskContext, USER_KICKOFF, userSystemPrompt } from "../sim/prompts.ts";
import { seedFor } from "../world/store.ts";
import { toolSchema } from "../world/tools.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

/** A spec item without the keys that only record its review (`review`, `source`), so accepting a draft keeps its hash. */
const unreviewed = <T extends object>(item: T) => Object.fromEntries(Object.entries(item).filter(([k]) => k !== "review" && k !== "source"));

/**
 * Two short hashes of one task's test, for `run --baseline` to tell a task whose test changed from one the
 * agent fixed or broke:
 * - `inputs`: what the agent and the caller are given and the world they act in: the agent's prompt (with the
 *   task's `given.context`), every tool's definition (what the agent sees and what the tool does), the caller's
 *   prompt and opening, the turn limit, the script when `user` is the scripted user, and the seed rows with the
 *   task's `given.rows` merged in. Seed rows and tools are shared, so editing one changes every task's hash.
 * - `grading`: how its trials are graded: the task's `expect` and `critical`, and every invariant (with `soft`),
 *   since a call to any tool can trip one.
 */
export function taskFingerprints(domain: Domain, task: Task, user: string): { inputs: string; grading: string } {
  const persona = domain.personas.find((p) => p.id === task.persona);
  return {
    inputs: hash({
      agent: agentSystemPrompt(domain, task),
      tools: domain.tools.map(unreviewed),
      kickoff: USER_KICKOFF,
      caller: userSystemPrompt(domain, task, persona),
      opening: task.user.opening,
      maxTurns: task.max_turns ?? domain.max_turns,
      ...(user === "scripted" ? { script: task.user.script } : {}),
      world: seedFor(domain, task),
    }),
    grading: hash({
      expect: task.expect,
      critical: task.critical ?? false,
      invariants: domain.invariants.map((inv) => {
        const { description: _, ...rest } = unreviewed(inv);
        return rest;
      }),
    }),
  };
}

/**
 * A short hash of what the agent and the simulated user are given in these tasks, as the current code
 * renders it: the agent's system prompt and tool schemas, and per task the caller's prompt, opening line
 * and turn limit, plus the script when `user` is the scripted user, the only one that reads it. A task with
 * a `given.context` adds the agent's prompt for that task, which states the context. A task without one
 * hashes exactly as in results written before `given` existed, so those runs can still be regraded.
 *
 * Invariants and expectations are left out, so editing how a trial is graded keeps the hash. Seed records,
 * a task's `given.rows` included, and what tools do are left out too: the agent sees them only through tool
 * results, which a regrade replays call by call. A task id missing from the domain hashes as missing.
 */
export function inputsFingerprint(domain: Domain, taskIds: readonly string[], user: string): string {
  const tasks = taskIds.map((id) => {
    const task = domain.tasks.find((t) => t.id === id);
    if (!task) return { id, missing: true };
    const persona = domain.personas.find((p) => p.id === task.persona);
    return {
      id,
      ...(taskContext(task) ? { agent: agentSystemPrompt(domain, task) } : {}),
      caller: userSystemPrompt(domain, task, persona),
      opening: task.user.opening,
      maxTurns: task.max_turns ?? domain.max_turns,
      ...(user === "scripted" ? { script: task.user.script } : {}),
    };
  });
  return hash({ agent: agentSystemPrompt(domain), tools: domain.tools.map(toolSchema), kickoff: USER_KICKOFF, tasks });
}
