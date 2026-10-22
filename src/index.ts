// The library API. From 1.0 these exports are a contract (docs/reference/library.mdx): adding one is a minor
// release, removing or renaming one a major. test/library.test.ts pins the list.

// Domains: load, parse and check them. The spec's types are TypeScript types only, so the schema library behind
// them is not part of the API.
export type { Domain, Tool, Op, Invariant, Task, StateAssert, CallExpect, ReferenceCall, FieldRefSpec, Persona, Given } from "./spec/schema.ts";
export { loadDomain, parseDomain, validateDomain, pendingReview, DomainError, DOMAIN_FILE, type PendingItem } from "./spec/load.ts";

// The simulated world and its tools, for an agent that runs tools itself.
export { World, type Change, type Snapshot } from "./world/store.ts";
export { executeTool, coerceArgs, toolSchema, type ToolOutcome, type ToolSchema } from "./world/tools.ts";

// Agents and simulated users.
export type * from "./sim/types.ts";
export { claudeAgent, claudeUser, type ClaudeOptions, type ClaudeAgentOptions } from "./sim/claude.ts";
export { openaiCompatAgent, openaiCompatUser, type OpenAICompatOptions, type OpenAICompatAgentOptions } from "./sim/openai-compat.ts";
export { httpAgent } from "./sim/http.ts";
export { bedrockConverseAgent, type BedrockConverseOptions } from "./sim/bedrock-converse.ts";
export { noopAgent } from "./sim/noop.ts";
export { scriptedUser } from "./sim/scripted.ts";

// Running, grading and comparing suites, and reading their results.
export { runSuite, criticalFailures, trialStatus, type SuiteOptions, type SuiteResult, type TaskSummary, type Verdict, type FailureMode, type SoftScore } from "./run/suite.ts";
export type { TrialResult, TrajectoryEvent, EndReason, SoftCheck } from "./run/episode.ts";
export type { CheckResult, CheckKind } from "./grade/expectations.ts";
export type { CallRecord, Violation } from "./grade/invariants.ts";
export type { CallerNote } from "./run/caller-notes.ts";
export type { Attribution, AttributionCounts, Owner } from "./run/attribution.ts";
export type { TokenUsage, UsageByModel, Usage, UsageRecorder } from "./run/usage.ts";
export { regradeSuite, RegradeError } from "./run/regrade.ts";
export { compareRuns, baselineSnapshot, type Comparison, type TaskDelta, type TaskChange, type BaselineSnapshot } from "./run/compare.ts";
export { lintDomain, type LintReport, type TaskLint } from "./grade/lint.ts";
export { passHatK, passAtK, wilsonInterval } from "./grade/passk.ts";

// Reports.
export { renderTerminal } from "./report/terminal.ts";
export { renderHtml } from "./report/html.ts";
