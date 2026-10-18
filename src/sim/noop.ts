import type { AgentAdapter } from "./types.ts";

/**
 * Baseline agent that never calls a tool and declines everything politely.
 * The share of a suite it passes is the share that rewards doing nothing,
 * typically the "must refuse" tasks. Read your real agent's score against it.
 */
export function noopAgent(): AgentAdapter {
  return {
    name: "noop",
    async createSession() {
      return {
        async reply() {
          return "Sorry, I can't help with that right now.";
        },
      };
    },
  };
}
