import type { Domain, Persona, Task } from "../spec/schema.ts";
import type { UsageRecorder } from "../run/usage.ts";
import type { ToolOutcome, ToolSchema } from "../world/tools.ts";

/** Executes a tool against the simulated world and records it in the trajectory. */
export type CallTool = (name: string, args: unknown) => Promise<ToolOutcome>;

export interface AgentContext {
  domain: Domain;
  /** Sandtable's default system prompt (domain description + policy). Your agent may use its own. */
  system: string;
  tools: ToolSchema[];
  sessionId: string;
  /** Report model usage so runs can show tokens and cost. Optional for custom adapters. */
  recordUsage?: UsageRecorder;
}

/**
 * One conversation with the agent under test. The agent owns its tool loop:
 * it calls `callTool` as many times as it wants, then returns its reply to the user.
 */
export interface AgentSession {
  reply(userMessage: string, callTool: CallTool): Promise<string>;
  close?(): Promise<void>;
}

export interface AgentAdapter {
  name: string;
  createSession(ctx: AgentContext): Promise<AgentSession>;
}

export interface UserTurn {
  text: string;
  /** The simulated user is done (goal met, impossible, or handed off). */
  stop: boolean;
}

export interface UserContext {
  domain: Domain;
  task: Task;
  persona?: Persona;
  recordUsage?: UsageRecorder;
}

export interface UserSession {
  /** `agentMessage` is null for the user's opening turn. */
  next(agentMessage: string | null): Promise<UserTurn>;
}

export interface UserSimulator {
  name: string;
  createSession(ctx: UserContext): Promise<UserSession>;
}
