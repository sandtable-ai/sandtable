# Changelog

All notable changes to sandtable are documented in this file: the `sandtable-ai` CLI and library on npm, its Python launcher on PyPI, and the Claude Code plugin in this repository, which share one version number.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, a minor release may change the domain spec, the CLI or the library API; every such change is marked **Breaking:** and says what to do.

<!-- Contributors and coding agents: add your entry under [Unreleased] in the same PR as the change. The brief is in AGENTS.md ("Changelog"). `npm version` moves [Unreleased] into a dated release. -->

## [Unreleased]

First public release.

### Added

- **Engine**:
  - domain spec: world tables, tools as atomic ops with checks and defaults, invariants, personas and tasks with hidden goals
  - simulated user ↔ agent episodes on a fresh world per trial. The simulated caller follows its task's instructions over its persona, says only what a customer would say aloud, asks for nothing its goal doesn't mention, and hangs up once it is transferred ([#85](https://github.com/sandtable-ai/sandtable/issues/85))
- **Grading**:
  - deterministic: end state, invariants on every tool call (`before`, `require`, `limit`, `match`, `never`), `never_disclose` on agent messages, required and forbidden tools
  - `never_disclose.unless` takes one exception or a list of them. The freight example uses a list so that a rep-confirm offer agreed at exactly `max_rate` can be read back and submitted, as the booked rate already could ([#86](https://github.com/sandtable-ai/sandtable/issues/86))
  - a YAML number matches a string with the same digits (`100101` and `"100101"`); zero-padded IDs such as `"007"` still differ from `7`
  - pass^k, failure-mode clustering, per-tag scores
- **`sandtable init`**: drafts a domain from an OpenAPI spec (deterministic), an SOP (invariants that quote their source) and call transcripts (tasks, personas and fictional seed rows, PII scrubbed locally). Everything stays `review: pending` until accepted.
- **`sandtable lint`**: proves each task is ready, solvable (reference replay), non-vacuous and graded, without model calls.
- **`sandtable leaderboard`**: ranks several agents on one domain under the same simulated callers, next to a do-nothing baseline, by pass^k with rule violations, cost per trial and p95 turn latency. It writes `leaderboard.json`, `LEADERBOARD.md` and `leaderboard.html`, and resumes an interrupted run without paying for finished models again. A model's stored results are reused only for the same domain, k, caller and tasks with no crashed trial; otherwise it reruns and says why. `-t` limits every model and the baseline to some tasks. A model whose trials crashed shows as an error instead of a 0% score. Cost / trial counts the agent's model only, and a `noop` entry is skipped in favour of the built-in baseline ([#93](https://github.com/sandtable-ai/sandtable/issues/93)).
- **Adapters**:
  - Claude on the Anthropic API or Amazon Bedrock (`--provider bedrock`), with prompt caching
  - any tool-capable model on Amazon Bedrock through the Converse API, such as GPT, gpt-oss, Grok, Kimi, Qwen, Mistral or Nova: `--agent bedrock:<model-id>`
  - any model behind an OpenAI-compatible Chat Completions endpoint (OpenAI, OpenRouter, LiteLLM, vLLM, Ollama, Groq, Together), as agent or simulated user: `--agent openai:<model>`, `--user openai:<model>`
  - HTTP step protocol, keyed by a `session_id` of `<run-id>/<task-id>#<trial>` that no other run reuses; JS/TS module agents; `noop` baseline; scripted user
  - the Claude, Bedrock and OpenAI-compatible adapters retry rate limits, server errors and network errors with backoff, so a long run doesn't lose trials to throttling
- **Reports**:
  - terminal summary, `results.json` (with the run's `runId`), and a self-contained HTML report with transcripts, tokens, estimated cost and turn latency. Each line of the summary's top failure modes fits an 80-column terminal: it names the first tasks that hit the failure and counts the rest (`… +24 more`), and long examples end in `…`. The full lists stay in `results.json` and the report ([#79](https://github.com/sandtable-ai/sandtable/issues/79))
  - `--fail-under` CI gate; `run --open` opens the report
  - `--prices <file>` adds verified prices for models sandtable doesn't price itself; `scripts/bedrock-prices.mjs` resolves Bedrock prices from the AWS Pricing API
  - the HTML report's trial view shows rule ids in their own case on the tool call that broke them, hangs each check's detail under its rule id, and wraps long tool arguments, results and record changes between fields instead of running past the card ([#70](https://github.com/sandtable-ai/sandtable/issues/70))
- **Claude Code plugin**: this repository is a plugin marketplace (`/plugin marketplace add sandtable-ai/sandtable`). Its skills teach a coding agent to draft and review a domain, write tasks, run it and attribute failures; a `failure-triager` subagent reads failing trials. Not part of the npm package.
- **Python launcher**: `uvx sandtable-ai` or `pip install sandtable-ai` installs a `sandtable` command that runs the matching CLI release (Node.js 20+ required).
- **Examples**:
  - a fictional freight carrier-sales desk with 32 tasks (16 that must write, 16 that must not) and 16 invariants. It covers vetting, search by lane, pickup window and equipment, multi-round negotiation with every counter-offer logged, offers a human rep confirms, capacity logging, callbacks and handoffs. `sandtable demo` rehearses it offline and opens the failing report. In the multi-round negotiation tasks the caller's floor is stated apart from its asking prices, so a simulated caller no longer turns down offers it should accept ([#87](https://github.com/sandtable-ai/sandtable/issues/87)).
  - a fictional clinic front desk with 25 tasks and 12 invariants, and offline careful and naive agents (`--agent scripted:clinic-careful`)
  - worked examples that rehearse agents built with the Vercel AI SDK, the OpenAI Agents SDK, the Claude Agent SDK, Pipecat, LiveKit Agents and a plain HTTP service, each a one-file adapter checked offline in CI, with a guide (`docs/guides/frameworks.mdx`) ([#52](https://github.com/sandtable-ai/sandtable/issues/52))
- **Docs** at [sandtable.dev](https://sandtable.dev), with `llms.txt` for coding agents: concepts, guides, a reference for the CLI, the domain spec, the HTTP step protocol and `results.json`, and comparisons with τ-bench, LangWatch Scenario, IntellAgent and hosted platforms, each claim linked to the tool's own docs ([#54](https://github.com/sandtable-ai/sandtable/issues/54)), and a guide to the Claude Code plugin: installing it, its skills and subagent, and a worked session ([#72](https://github.com/sandtable-ai/sandtable/issues/72)).
- The published CLI runs on Node.js 20 or later.

### Fixed

- `examples/freight`: offering `max_rate` as a logged counter-offer is no longer graded as disclosing it. The policy says so, and `never-disclose-ceiling` exempts `log_offer.counter_offer`; the README's design note explains why. Saying the ceiling any other way still fails ([#118](https://github.com/sandtable-ai/sandtable/issues/118)).
- `sandtable lint` ends with how many tasks a do-nothing agent passes, for example `a do-nothing agent passes 9 of 25` on the clinic example. It used to say the noop baseline passes every task that expects no write, which is false when a refusal must also look something up ([#100](https://github.com/sandtable-ai/sandtable/issues/100)).
- **Error messages** for the setup problems a new user hits first say what to do ([#96](https://github.com/sandtable-ai/sandtable/issues/96)):
  - a missing `ANTHROPIC_API_KEY` names the key, instead of the SDK's "Could not resolve authentication method"
  - an unreachable HTTP agent names its URL and the reason, instead of "fetch failed"
  - an unknown `--agent` lists the valid forms
  - a missing optional package says to install it next to `sandtable-ai`, or to name both packages with `npx -p`; a package installed on its own was invisible to `npx sandtable-ai`
  - `report` refuses a file that isn't a `results.json`
- **README**: every link and image is an absolute URL, so they work on the npmjs.com package page and in any viewer of the README shipped in the package, dark-mode screenshots included ([#103](https://github.com/sandtable-ai/sandtable/issues/103)).
- `init --openapi` refuses a Swagger 2.0 spec, a file without `openapi: 3.x` and a spec it can't draft a single tool from, and writes nothing. Before, it wrote a domain with 0 tools, which `validate` then rejected ([#98](https://github.com/sandtable-ai/sandtable/issues/98)).
- `validate` and `lint` reject a `never_disclose` invariant on a field that holds booleans, or only strings shorter than 3 characters, in the seed rows. Such an invariant could never fire, so a reviewer could believe the value was protected. `init --sop` drops such a draft with a warning when the domain has seed rows ([#116](https://github.com/sandtable-ai/sandtable/issues/116)).
- `sandtable --version` reports the installed version; 0.1.0-alpha.1 printed `0.1.0-alpha.0` ([#88](https://github.com/sandtable-ai/sandtable/issues/88)).
- `examples/freight` and `examples/clinic` work under `npx sandtable-ai` from any directory. When the folder isn't there, `validate`, `lint`, `review`, `run` and `leaderboard` use the copy bundled with the package and print its path; a folder of that name in the current directory still wins. The commands in the docs, the example READMEs and the plugin skills run as written. The `--prices` help and the leaderboard docs no longer point npm users at files that exist only in a clone ([#99](https://github.com/sandtable-ai/sandtable/issues/99)).
- `leaderboard` reruns a model when its agent spec changed under the same label (for example a newer model ID under "Claude Sonnet") or when the domain's files changed, and says why, for example `stored results not reused: they are for agent scripted:careful, not scripted:naive`. Before, it reused the old results and ranked them under the new spec ([#127](https://github.com/sandtable-ai/sandtable/issues/127)).
- `run` and `demo --live` exit 1 and print the error when every trial ended in one, for example without `ANTHROPIC_API_KEY`, without an optional Bedrock package or with the agent's server down. Before, they printed a 0% score and exited 0 ([#95](https://github.com/sandtable-ai/sandtable/issues/95)).
- `npx sandtable-ai` on Node.js 20 prints no `EBADENGINE` warning, and installs with `engine-strict=true`: the CLI uses commander 14, which supports Node 20, instead of commander 15, which requires Node 22.12 ([#101](https://github.com/sandtable-ai/sandtable/issues/101)).
- **Python launcher**: the `sandtable` command becomes the `npx` process instead of waiting on it, so stopping it with SIGTERM (a process manager, a CI cancel) also stops the CLI. Without network it starts from npm's cache in about 4 seconds instead of 70. It tells you to install npm when Node.js is there but `npx` isn't, and the wheel ships the MIT license ([#104](https://github.com/sandtable-ai/sandtable/issues/104)).
- `sandtable.yaml`: a `policy`, `world` or `tasks` path to a missing file fails validation and names the file. Before, a misspelled `policy: ./polcy.md` passed `validate`, and every run gave the agent the text `./polcy.md` as its policy. YAML syntax errors now name the file they are in ([#97](https://github.com/sandtable-ai/sandtable/issues/97)).

## [0.1.0-alpha.1] - 2026-10-19

A rehearsal of the release pipeline (npm, PyPI and GitHub releases from one tag), published before the first public release. It contains everything listed under [Unreleased]; use 0.1.0 instead.

[Unreleased]: https://github.com/sandtable-ai/sandtable/compare/v0.1.0-alpha.1...HEAD
[0.1.0-alpha.1]: https://github.com/sandtable-ai/sandtable/releases/tag/v0.1.0-alpha.1
