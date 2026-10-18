import type { UserSimulator } from "./types.ts";

/**
 * Deterministic user that replays `task.user.script` line by line, then stops.
 * Useful for CI smoke runs, debugging graders, and running without API keys.
 */
export function scriptedUser(): UserSimulator {
  return {
    name: "scripted",
    async createSession({ task }) {
      const script = task.user.script ?? (task.user.opening ? [task.user.opening] : []);
      if (script.length === 0) throw new Error(`task ${task.id} has no user.script for the scripted user`);
      let i = 0;
      return {
        async next() {
          if (i >= script.length) return { text: "", stop: true };
          return { text: script[i++]!, stop: false };
        },
      };
    },
  };
}
