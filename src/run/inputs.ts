import { createHash } from "node:crypto";
import type { Domain } from "../spec/schema.ts";
import { agentSystemPrompt, USER_KICKOFF, userSystemPrompt } from "../sim/prompts.ts";
import { toolSchema } from "../world/tools.ts";

/**
 * A short hash of everything the agent and the simulated user are given in these tasks, as the current
 * code renders it: the agent's system prompt, each tool's schema and behaviour, the seed records, and
 * each task's caller prompt, opening, script and turn limit. Invariants and expectations are left out,
 * so editing how a trial is graded keeps the hash, while any edit that could change the conversation
 * changes it. A task id missing from the domain hashes as missing.
 */
export function inputsFingerprint(domain: Domain, taskIds: readonly string[]): string {
  const tasks = taskIds.map((id) => {
    const task = domain.tasks.find((t) => t.id === id);
    if (!task) return { id, missing: true };
    const persona = domain.personas.find((p) => p.id === task.persona);
    return { id, caller: userSystemPrompt(domain, task, persona), user: task.user, maxTurns: task.max_turns ?? domain.max_turns };
  });
  const inputs = {
    agent: agentSystemPrompt(domain),
    tools: domain.tools.map((t) => ({ schema: toolSchema(t), checks: t.checks, ops: t.ops, returns: t.returns })),
    world: domain.world,
    kickoff: USER_KICKOFF,
    tasks,
  };
  return createHash("sha256").update(JSON.stringify(inputs)).digest("hex").slice(0, 16);
}
