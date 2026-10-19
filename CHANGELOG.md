# Changelog

All notable changes to sandtable are documented in this file: the `sandtable-ai` CLI and library on npm, its Python launcher on PyPI, and the Claude Code plugin in this repository, which share one version number.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, a minor release may change the domain spec, the CLI or the library API; every such change is marked **Breaking:** and says what to do.

<!-- Contributors and coding agents: add your entry under [Unreleased] in the same PR as the change. The brief is in AGENTS.md ("Changelog"). `npm version` moves [Unreleased] into a dated release. -->

## [Unreleased]

First public release.

### Added

- **Engine**:
  - domain spec: world tables, tools as atomic ops with checks and defaults, invariants, personas and tasks with hidden goals
  - simulated user ↔ agent episodes on a fresh world per trial
- **Grading**:
  - deterministic: end state, invariants on every tool call (`before`, `require`, `limit`, `match`, `never`), `never_disclose` on agent messages, required and forbidden tools
  - a YAML number matches a string with the same digits (`100101` and `"100101"`); zero-padded IDs such as `"007"` still differ from `7`
  - pass^k, failure-mode clustering, per-tag scores
- **`sandtable init`**: drafts a domain from an OpenAPI spec (deterministic), an SOP (invariants that quote their source) and call transcripts (tasks, personas and fictional seed rows, PII scrubbed locally). Everything stays `review: pending` until accepted.
- **`sandtable lint`**: proves each task is ready, solvable (reference replay), non-vacuous and graded, without model calls.
- **`sandtable leaderboard`**: ranks several agents on one domain under the same simulated callers, next to a do-nothing baseline, by pass^k with rule violations, cost per trial and p95 turn latency. It writes `leaderboard.json`, `LEADERBOARD.md` and `leaderboard.html`, and resumes an interrupted run without paying for finished models again.
- **Adapters**:
  - Claude on the Anthropic API or Amazon Bedrock (`--provider bedrock`), with prompt caching
  - any tool-capable model on Amazon Bedrock through the Converse API, such as GPT, gpt-oss, Grok, Kimi, Qwen, Mistral or Nova: `--agent bedrock:<model-id>`
  - any model behind an OpenAI-compatible Chat Completions endpoint (OpenAI, OpenRouter, LiteLLM, vLLM, Ollama, Groq, Together), as agent or simulated user: `--agent openai:<model>`, `--user openai:<model>`
  - HTTP step protocol, keyed by a `session_id` of `<run-id>/<task-id>#<trial>` that no other run reuses; JS/TS module agents; `noop` baseline; scripted user
  - the Claude, Bedrock and OpenAI-compatible adapters retry rate limits, server errors and network errors with backoff, so a long run doesn't lose trials to throttling
- **Reports**:
  - terminal summary, `results.json` (with the run's `runId`), and a self-contained HTML report with transcripts, tokens, estimated cost and turn latency
  - `--fail-under` CI gate; `run --open` opens the report
  - `--prices <file>` adds verified prices for models sandtable doesn't price itself; `scripts/bedrock-prices.mjs` resolves Bedrock prices from the AWS Pricing API
- **Claude Code plugin**: this repository is a plugin marketplace (`/plugin marketplace add sandtable-ai/sandtable`). Its skills teach a coding agent to draft and review a domain, write tasks, run it and attribute failures; a `failure-triager` subagent reads failing trials. Not part of the npm package.
- **Python launcher**: `uvx sandtable-ai` or `pip install sandtable-ai` installs a `sandtable` command that runs the matching CLI release (Node.js 20+ required).
- **Examples**:
  - a fictional freight carrier-sales desk with 32 tasks (16 that must write, 16 that must not) and 16 invariants. It covers vetting, search by lane, pickup window and equipment, multi-round negotiation with every counter-offer logged, offers a human rep confirms, capacity logging, callbacks and handoffs. `sandtable demo` rehearses it offline and opens the failing report.
  - a fictional clinic front desk with 25 tasks and 12 invariants, and offline careful and naive agents (`--agent scripted:clinic-careful`)
- **Docs** at [sandtable.dev](https://sandtable.dev), with `llms.txt` for coding agents: concepts, guides, a reference for the CLI, the domain spec, the HTTP step protocol and `results.json`, and comparisons with τ-bench, LangWatch Scenario, IntellAgent and hosted platforms, each claim linked to the tool's own docs ([#54](https://github.com/sandtable-ai/sandtable/issues/54)).
- The published CLI runs on Node.js 20 or later.
