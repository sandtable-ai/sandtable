# Changelog

## 0.1.0 (unreleased)

First public release.

- **Engine**:
  - domain spec: world tables, tools as atomic ops with checks and defaults, invariants, personas and tasks with hidden goals
  - simulated user ↔ agent episodes on a fresh world per trial
- **Grading**:
  - deterministic: end state, invariants on every tool call (`before`, `require`, `limit`, `match`, `never`), `never_disclose` on agent messages, required and forbidden tools
  - pass^k, failure-mode clustering, per-tag scores
- **`sandtable init`**: drafts a domain from an OpenAPI spec (deterministic), an SOP (invariants that quote their source) and call transcripts (tasks, personas and fictional seed rows, PII scrubbed locally). Everything stays `review: pending` until accepted.
- **`sandtable lint`**: proves each task is ready, solvable (reference replay), non-vacuous and graded, without model calls.
- **Adapters**:
  - Claude on the Anthropic API or Amazon Bedrock (`--provider bedrock`), with prompt caching
  - any model behind an OpenAI-compatible Chat Completions endpoint (OpenAI, OpenRouter, LiteLLM, vLLM, Ollama, Groq, Together), as agent or simulated user: `--agent openai:<model>`, `--user openai:<model>`
  - HTTP step protocol, JS/TS module agents, `noop` baseline, scripted user
- **Reports**: terminal summary, `results.json`, a self-contained HTML report with transcripts, tokens, estimated cost and turn latency; `--fail-under` CI gate.
- **Claude Code plugin**: this repository is a plugin marketplace (`/plugin marketplace add sandtable-ai/sandtable`). Its skills teach a coding agent to draft and review a domain, write tasks, run it and attribute failures; a `failure-triager` subagent reads failing trials. Not part of the npm package.
- **Example**: a fictional freight carrier-sales desk with 10 tasks and 5 invariants, and an offline demo.
