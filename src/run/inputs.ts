import { createHash } from "node:crypto";
import type { Domain } from "../spec/schema.ts";
import { agentSystemPrompt, taskContext, USER_KICKOFF, userSystemPrompt } from "../sim/prompts.ts";
import { toolSchema } from "../world/tools.ts";

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
  const inputs = { agent: agentSystemPrompt(domain), tools: domain.tools.map(toolSchema), kickoff: USER_KICKOFF, tasks };
  return createHash("sha256").update(JSON.stringify(inputs)).digest("hex").slice(0, 16);
}
