# Roadmap

Issues and milestones on GitHub are the source of truth; this page is the overview.

## v0.1: engine
- [x] Domain spec: world, tools (get/list/create/update/respond, checks, atomic ops, param defaults), invariants, personas, tasks
- [x] Episode runner: simulated user ↔ agent, tool calls against a fresh world per trial
- [x] Deterministic grading: end state, invariants on every tool call, required and forbidden tools; pass^k; failure-mode clustering
- [x] Adapters: Claude reference agent, Claude simulated user, scripted user, `noop` baseline, HTTP step protocol, JS/TS module agents
- [x] Reports: terminal, `results.json`, self-contained `report.html`, per-tag scores, token usage, estimated cost, turn latency; `--fail-under` CI gate
- [x] Bundled example: freight carrier sales (32 tasks, 16 invariants), offline demo

## v0.2: `sandtable init` and trustworthy suites
- [x] OpenAPI → world tables and tools, deterministic (#6)
- [x] SOP → invariants, each quoting its source (#7)
- [x] Transcripts → personas, tasks and fictional seed rows, PII scrubbed first (#8)
- [x] Review workflow: `review: pending`, `sandtable review`, `validate --strict`, provisional reports (#9)
- [x] `sandtable lint`: ready, solvable, non-vacuous, graded (#10)
- [x] `never_disclose`: protected values in agent messages (#24)
- [x] OpenAI-compatible agent and simulated user, for comparing models: `--agent openai:<model>` (#19)
- [x] Live verification of the Claude adapters, caching and init steps (#1, #3); see [docs/results.mdx](docs/results.mdx)
- [x] Claude on Amazon Bedrock (#46) and the Bedrock Converse adapter for non-Claude models (#56)
- [x] Agent skills and a Claude Code plugin, so coding agents can draft, run and debug suites (#51)
- [ ] First release to npm and PyPI through Trusted Publishing (#23)

## v0.3: closing the loop in CI
- [ ] Baseline comparison and PR comments with pass^k deltas (#12, #13)
- [ ] Reliability verdicts: pass@k, flaky tasks, flip rate, intervals, infra errors as SKIPPED (#27)
- [ ] Critical tasks (#28), failure attribution (#29), coverage matrix (#30)
- [ ] Customer sign-off report: rule → evidence → reliability (#31)
- [ ] Regrade stored trials (#32), argument matchers (#25), nested params (#26), per-task `given` overrides (#37)
- [x] A realistic freight example: negotiation rounds, rep-confirm offers, capacity and callbacks (#45)
- [x] A second example domain: clinic front desk, 25 tasks and 12 invariants (#22)

## v0.4: black-box and platform on-ramps
- [ ] Serve the world as REST, MCP and webhook tools for hosted agent platforms (#14)
- [ ] Import voice-agent platform configs as draft domains (#34, #35)
- [ ] Fault profiles (#15)

## Later
Soft checks (#16), voice transport and timing metrics (#17, #43), exports to other harness formats (#18), negotiation invariants (#36), simulation clock (#38), outcome grading (#39), business metrics (#40), persona × condition matrix (#41), multi-session tasks (#42), Python agents in-process (#44).

## Good first issues
`$regex` in where clauses (#20), `--tag` filter (#21).
