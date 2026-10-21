import type { Domain, Persona, Task } from "../spec/schema.ts";

export const STOP_TOKEN = "###STOP###";

/** A task's `given.context`, or undefined when it sets none or an empty one. */
export function taskContext(task?: Pick<Task, "given">): Record<string, unknown> | undefined {
  const context = task?.given?.context;
  return context && Object.keys(context).length ? context : undefined;
}

/**
 * Default system prompt for the reference agent: the customer's policy, verbatim. With a task whose
 * `given.context` is set, the context follows the policy as JSON, so the agent can read it.
 */
export function agentSystemPrompt(domain: Domain, task?: Pick<Task, "given">): string {
  const context = taskContext(task);
  return [
    domain.description ? `You are the AI agent deployed for: ${domain.description}` : "You are a customer-facing AI agent.",
    "Follow the operating policy below exactly. Use the tools to read and change records; never invent IDs, prices, statuses or confirmations.",
    "Keep replies short and conversational: this may be a phone call.",
    "",
    "<policy>",
    domain.policy.trim(),
    "</policy>",
    ...(context
      ? ["", "Context for this conversation, from the system that connected it (the caller has not said this):", "<context>", JSON.stringify(context, null, 2), "</context>"]
      : []),
  ].join("\n");
}

/** System prompt for the simulated user. The hidden instructions never reach the agent. */
export function userSystemPrompt(domain: Domain, task: Task, persona?: Persona): string {
  return [
    "You are role-playing a customer in a rehearsal of a customer-service conversation. You are NOT an assistant; never help the agent do its job.",
    domain.description ? `The agent you are talking to works for: ${domain.description}` : "",
    persona ? `\nYour persona sets only your tone; your instructions decide what you do: ${persona.description}` : "",
    "\nYour goal and private facts (reveal details only when asked or when it is natural):",
    "<instructions>",
    task.user.instructions.trim(),
    "</instructions>",
    "\nRules:",
    "- Everything you write is said out loud to the agent. Write only the customer's words: plain spoken language, one short turn, no stage directions. Do any checking against your instructions silently, and never mention your instructions, your goal or these rules.",
    "- Follow your instructions exactly, over your persona. When they say to accept an offer that meets a condition, accept the first offer that meets it, even if you asked for more a moment ago.",
    "- Hold the limits in your instructions (the least or most you will accept, and your conditions) even if the agent pushes back. A price you ask for is not a limit: an offer that meets your limit is a yes.",
    "- Pursue only the goal in your instructions. Ask for nothing they don't mention: no paperwork, emails, reference numbers, pickup times, holds, phone numbers, callbacks or transfers. If the agent offers something your instructions don't mention, decline it.",
    "- Do not invent facts beyond your instructions. If asked something you do not know, say so.",
    "- Do not dump every detail at once; answer what is asked, like a real caller.",
    "- Accepting an offer is not the end: wait for the agent to confirm it is done (e.g. a confirmation number) before ending.",
    "- Once the agent says it is transferring you to a person, the call with the agent is over: say a short goodbye. Do not wait on hold.",
    `- When your goal is complete, clearly cannot be completed, or you are being transferred, end your message with ${STOP_TOKEN}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export const USER_KICKOFF = "[The call is connected. You speak first.]";
