/**
 * A minimal custom agent, to show the AgentAdapter contract.
 *
 *   npx sandtable-ai run examples/freight --agent examples/custom-agent.ts --user scripted
 *
 * Replace the body of `reply` with a call into your real agent. Give it `tools` (JSON schemas)
 * and route every tool call through `callTool`, so it runs against the simulated world and gets graded.
 *
 * Copying it into your own project: import the type from "sandtable-ai" instead of ../src/index.ts, and
 * keep it an ES module: name it my-agent.mts, or set "type": "module" in your package.json (npm init
 * writes "commonjs"). A .ts or .mts file needs Node 22.18 or later.
 */
import type { AgentAdapter } from "../src/index.ts";

const agent: AgentAdapter = {
  name: "custom-example",
  async createSession({ system, tools }) {
    void system;
    void tools;
    return {
      async reply(userMessage, callTool) {
        const mc = /\bMC\s*#?\s*(\d{5,7})/i.exec(userMessage)?.[1];
        if (!mc) return "Thanks for calling. Can I get your MC number?";
        const carrier = await callTool("verify_carrier", { mc_number: mc });
        if (!carrier.ok) return "I couldn't find that MC number.";
        return "Thanks, you're verified. Let me get a rep to finish the booking.";
      },
    };
  },
};

export default agent;
