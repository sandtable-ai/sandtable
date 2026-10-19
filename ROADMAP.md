# Roadmap

Issues and milestones on GitHub are the source of truth; this page is the overview, mirrored at [sandtable.dev/roadmap](https://sandtable.dev/roadmap).

## In 0.1.0, the first release
- [x] Domain spec: world, tools (get/list/create/update/respond, checks, atomic ops, param defaults), invariants, personas, tasks
- [x] Episode runner: simulated user ↔ agent, tool calls against a fresh world per trial
- [x] Deterministic grading: end state, invariants on every tool call, `never_disclose` on agent messages, required and forbidden tools; pass^k; failure-mode clustering (#24)
- [x] Adapters: Claude as agent and simulated user on the Anthropic API or Amazon Bedrock, the Bedrock Converse adapter for non-Claude models, OpenAI-compatible endpoints, the HTTP step protocol, JS/TS module agents, a scripted user and the `noop` baseline (#46, #56, #19)
- [x] Reports: terminal, `results.json`, self-contained `report.html`, per-tag scores, token usage, estimated cost, turn latency; `--fail-under` CI gate
- [x] `sandtable init`: OpenAPI → world tables and tools (deterministic), SOP → invariants that quote their source, transcripts → personas, tasks and fictional seed rows with PII scrubbed first (#6, #7, #8)
- [x] Review workflow: `review: pending`, `sandtable review`, `validate --strict`, provisional reports (#9)
- [x] `sandtable lint`: ready, solvable, non-vacuous, graded (#10)
- [x] `sandtable leaderboard`: several agents on one domain under the same simulated callers, next to a do-nothing baseline
- [x] Live verification of the Claude adapters, caching and init steps (#1, #3); see [docs/results.mdx](docs/results.mdx)
- [x] Bundled examples with offline demo agents: a freight carrier-sales desk with negotiation rounds, rep-confirm offers, capacity and callbacks, and a clinic front desk (#45, #22)
- [x] Worked examples for six agent frameworks (#52)
- [x] A Claude Code plugin whose skills and subagent let coding agents draft, run and debug suites (#51)
- [x] This docs site, with `llms.txt` (#50)
- [x] Packages on npm and PyPI, published from one tag (#23)

## Next: closing the loop in CI (milestone v0.3)
- [ ] Baseline comparison and PR comments with pass^k deltas (#12, #13)
- [ ] Reliability verdicts: pass@k, flaky tasks, flip rate, intervals, infra errors as SKIPPED (#27)
- [ ] Critical tasks (#28), failure attribution (#29), coverage matrix (#30)
- [ ] Customer sign-off report: rule → evidence → reliability (#31)
- [ ] Regrade stored trials (#32), argument matchers (#25), nested params (#26), per-task `given` overrides (#37)

## Then: black-box and platform on-ramps (milestone v0.4)
- [ ] Serve the world as REST, MCP and webhook tools for hosted agent platforms (#14)
- [ ] Import voice-agent platform configs as draft domains (#34, #35)
- [ ] Fault profiles (#15)

## Later
LLM-judged checks (#16), voice transport and timing metrics (#17, #43), exports to other harness formats (#18), negotiation invariants (#36), simulation clock (#38), outcome grading (#39), business metrics (#40), persona × condition matrix (#41), multi-session tasks (#42), Python agents in-process (#44).

## Good first issues
`$regex` in where clauses (#20), `--tag` filter (#21).
