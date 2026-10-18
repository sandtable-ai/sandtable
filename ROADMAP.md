# Roadmap

## v0.1: engine (this release)
- [x] Domain spec: world, tools (get/list/create/update/respond, checks, atomic ops), invariants (before, require, limit, match, never), personas, tasks
- [x] Episode runner: simulated user ↔ agent, tool calls against a fresh world per trial
- [x] Deterministic grading: end state, invariants, required and forbidden tools; pass^k; failure-mode clustering
- [x] Adapters: Claude reference agent, Claude simulated user, scripted user, HTTP agent protocol, JS/TS module agents
- [x] Reports: terminal, `results.json`, self-contained `report.html`; `--fail-under` CI gate
- [x] Bundled example: freight carrier sales (10 tasks, 4 invariants), offline demo

## v0.2: `rehearse init` (the headline feature)
Draft a domain from what a customer actually hands over: an SOP or policy doc, an OpenAPI spec, and call or chat transcripts.
- [ ] OpenAPI → `world.tables` (resources, keys, field types) and `tools` (operations → ops), with fixtures from schema examples
- [ ] SOP → candidate `invariants`, each quoting the sentence it came from, for human review
- [ ] Transcripts → personas and tasks with hidden goals and expected end states (PII scrubbed first)
- [ ] Output is a *draft*: every generated item is marked `review: pending` until a person accepts it
- [ ] Task-quality lint: a do-nothing agent and a scripted "perfect" agent bound every task (catches trivial or impossible tasks)

## v0.3: closing the loop in CI
- [ ] `--baseline <results.json>`: per-task deltas, new failures first
- [ ] GitHub Action that comments pass^k deltas on pull requests
- [ ] Per-tag scores in reports (`refusal`, `negotiation`, …), so refusal-heavy suites can't hide a broken happy path
- [ ] Cost and latency per trial; response caching for the simulated user

## v0.4: black-box mode
- [ ] Serve the simulated world as REST (from the OpenAPI spec) and as an MCP server, so an unmodified agent can be rehearsed by changing its base URL
- [ ] Fault profiles: timeouts after commit, 429 with Retry-After, duplicate webhooks

## Later
- [ ] Soft checks: LLM-judged criteria (tone, never disclosing the ceiling), reported separately and calibrated against human labels
- [ ] Voice: rehearse phone agents over WebSocket/WebRTC audio with a TTS/STT caller, plus turn latency and barge-in metrics
- [ ] More adapters: OpenAI Responses, Claude Agent SDK, MCP-client agents
- [ ] Export to τ-bench's domain format
- [ ] More example domains: clinic front desk, e-commerce returns, IT helpdesk

## Good first issues
- Add a `noop` built-in agent (useful baseline: the share of tasks a do-nothing agent passes)
- Add `$regex` to where clauses
- `rehearse run --tag refusal` to filter tasks by tag
- A second example domain
