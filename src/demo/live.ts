import { claudeAgent, claudeUser, type ClaudeOptions } from "../sim/claude.ts";
import type { AgentAdapter, UserSimulator } from "../sim/types.ts";

/**
 * The simulated caller's model in `demo --live` unless `--user-model` names another: a cheaper model plays the
 * carrier, so a first live run costs about half of what Claude Opus 5.5 on both sides would. `run --user claude`
 * keeps the default model; only the demo picks this one.
 */
export const DEMO_USER_MODEL = "claude-haiku-5-5";

/** The agent and the caller `demo --live` rehearses: Claude on both sides, the agent at its default model. */
export function demoLiveSides(p: ClaudeOptions, models: { agentModel?: string; userModel?: string } = {}): { agent: AgentAdapter; user: UserSimulator } {
  return {
    agent: claudeAgent({ ...p, ...(models.agentModel ? { model: models.agentModel } : {}) }),
    user: claudeUser({ ...p, model: models.userModel ?? DEMO_USER_MODEL }),
  };
}
