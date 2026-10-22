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
- [x] `sandtable regrade`: re-score stored trials after editing the domain's rules, without calling a model (#32)
- [x] Live verification of the Claude adapters, caching and init steps (#1, #3); see [docs/results.mdx](docs/results.mdx)
- [x] Bundled examples with offline demo agents: a freight carrier-sales desk with negotiation rounds, rep-confirm offers, capacity and callbacks, and a clinic front desk (#45, #22)
- [x] Worked examples for six agent frameworks (#52)
- [x] A Claude Code plugin whose skills and subagent let coding agents draft, run and debug suites (#51)
- [x] This docs site, with `llms.txt` (#50)
- [x] Packages on npm and PyPI, published from one tag (#23)

## In 0.2.0
- [x] Baseline comparison: `run --baseline` lists the tasks that broke, got worse, got fixed or changed since an earlier run (#12, #309)
- [x] Reliability verdicts: pass@k, flaky tasks, flip rate and intervals; trials that end in an error are skipped, not failed (#27)
- [x] Critical tasks that fail the run whatever the score (#28)
- [x] Argument matchers in `called` and `not_called` (#25), per-task `given` rows and context (#37), `reference` calls the API rejects (#274)
- [x] Exit 1 for a failed gate and 2 for an error (#282)
- [x] `init`: drafts keep their sources' facts and quote every rule, drafted tasks carry reference calls, and each step prints its plan with `--dry-run` and what it cost (#276, #277, #278, #296, #297)
- [x] A simulated caller that says it doesn't know a fact its instructions leave out, instead of inventing one (#287)
- [x] The Claude Code plugin installs from the release tag (#301), and sandtable.dev documents the latest release (#313)

## Next: 0.3.0, the last release before 1.0 (milestone v0.3)
0.3.0 is the last release that may change the contracts 1.0 freezes, so everything that could change them lands in it.
- [ ] Critical tasks and skipped trials in `leaderboard` and `demo --live` (#284)
- [ ] Failure attribution: agent, simulated user, task or infrastructure (#29)
- [ ] Nested params: objects and arrays in tool schemas (#26)
- [ ] Readers of `results.json` check its version (#349)
- [ ] Node 22 and Python 3.10 as the oldest supported versions (#350)
- [ ] A last review of every contract before it freezes (#351)
- [ ] A regression gate (#281), comparing two stored runs (#285), per-tag pass^k floors (#283)

## 1.0: stable contracts (milestone v1.0)
1.0 promises that the domain spec, `results.json`, CLI commands, flags and exit codes, the HTTP step protocol and the library's exports change only in a major release.
- [ ] A stability policy: what is covered, semver, and the deprecation window (#352)
- [ ] A release candidate, tested end to end before 1.0.0 (#353)

## After 1.0 (milestones v1.1 and black-box)
- [ ] PR comments with pass^k deltas (#13), coverage matrix (#30), customer sign-off report: rule → evidence → reliability (#31)
- [ ] Black-box and platform on-ramps: serve the world as REST, MCP and webhook tools for hosted agent platforms (#14), import voice-agent platform configs as draft domains (#34, #35), fault profiles (#15)

## Later
LLM-judged checks (#16), voice transport and timing metrics (#17, #43), exports to other harness formats (#18), negotiation invariants (#36), simulation clock (#38), outcome grading (#39), business metrics (#40), persona × condition matrix (#41), multi-session tasks (#42), Python agents in-process (#44).

## Good first issues
`$regex` in where clauses (#20), `--tag` filter (#21).
