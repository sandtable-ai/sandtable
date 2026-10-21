export * from "./spec/schema.ts";
export { loadDomain, validateDomain, pendingReview, DomainError, DOMAIN_FILE, type PendingItem } from "./spec/load.ts";
export { World, worldFor, seedFor, diffSnapshots, type Change, type Snapshot } from "./world/store.ts";
export { executeTool, coerceArgs, toolSchema, type ToolOutcome, type ToolSchema } from "./world/tools.ts";
export { checkCall, invariantTool, type CallRecord, type Violation } from "./grade/invariants.ts";
export { gradeTrial, type CheckResult, type CheckKind } from "./grade/expectations.ts";
export { passHatK, passAtK, wilsonInterval, binom } from "./grade/passk.ts";
export { lintDomain, type LintReport, type TaskLint } from "./grade/lint.ts";
export type * from "./sim/types.ts";
export { claudeAgent, claudeUser, DEFAULT_MODEL, type ClaudeOptions, type ClaudeAgentOptions } from "./sim/claude.ts";
export {
  openaiCompatAgent,
  openaiCompatUser,
  DEFAULT_OPENAI_BASE_URL,
  type OpenAICompatOptions,
  type OpenAICompatAgentOptions,
} from "./sim/openai-compat.ts";
export { httpAgent } from "./sim/http.ts";
export { bedrockConverseAgent, type BedrockConverseOptions } from "./sim/bedrock-converse.ts";
export { noopAgent } from "./sim/noop.ts";
export { scriptedUser } from "./sim/scripted.ts";
export { agentSystemPrompt, userSystemPrompt, STOP_TOKEN } from "./sim/prompts.ts";
export { runEpisode, type TrialResult, type TrajectoryEvent, type EndReason, type SoftCheck } from "./run/episode.ts";
export { callerNotes, type CallerNote } from "./run/caller-notes.ts";
export { runSuite, criticalFailures, trialStatus, type SuiteOptions, type SuiteResult, type TaskSummary, type Verdict, type FailureMode, type SoftScore } from "./run/suite.ts";
export { regradeSuite, regradeTrial, RegradeError } from "./run/regrade.ts";
export { compareRuns, baselineSnapshot, type Comparison, type TaskDelta, type TaskChange, type BaselineSnapshot } from "./run/compare.ts";
export { renderTerminal } from "./report/terminal.ts";
export { renderHtml } from "./report/html.ts";
