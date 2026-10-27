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

## In 0.3.0
- [x] Regression gates: `run --fail-on-regression` (#281), `sandtable compare` for two stored runs (#285), per-tag pass^k floors with `--floor` (#283)
- [x] `leaderboard` and `demo --live` treat critical tasks and skipped trials as `run` does (#284)
- [x] Failure attribution: each trial that didn't pass names a likely owner, agent, simulated user, task spec or harness, from deterministic evidence (#29, #385)
- [x] Nested params: objects, arrays and nullable fields in tool schemas, `$contains` and dotted fields in where clauses, and `init --openapi` mapping nested bodies (#26)
- [x] Contracts readied for 1.0: `results.json` readers check its version and it records the sandtable-ai that wrote it (#349, #372), the library exports only its documented API (#370), reference pages kept in step with the code by tests (#371), and a stability policy (#352)
- [x] Node.js 22 and Python 3.10 as the oldest supported versions (#350)
- [x] Freight example fixes: callers that know their truck's availability and don't repeat the agent's numbers (#346, #383), and a made-up load ID filed under its own rule (#163)

## In 1.0
- [x] Stable contracts: the domain spec, `results.json`, CLI commands, flags and exit codes, the HTTP step protocol and the library's exports change only in a major release, as the stability policy says (#352, #394)
- [x] A release candidate, `1.0.0-rc.1`, tested end to end before 1.0.0 (#353)
- [x] `init --transcripts` flags names, usernames, emails, phone numbers and street addresses a draft copied from its chats, and `sandtable review` shows each item's notes (#388)
- [x] The drafting skill writes the plan of a paid `init` as its own message, and waits for a go-ahead unless model steps are authorized (#392)

## In 1.1
- [x] Coverage: `run` shows which rules its trials checked and which they caught broken, and `lint` says which rules the tasks put in play (#30)
- [x] A customer sign-off report, `report --audience customer`: each rule with its source, the scenarios that checked it and the open items, with `run --without-policy` as a careless agent that shows the scenarios can catch a mistake (#31, #405)
- [x] `run --tag` runs only some tags (#21), and a repeated `--tasks` adds its tasks (#403)
- [x] The Claude Code plugin keeps `npm install` of sandtable in the working folder's own project (#412)

## Next (milestone black-box)
- [ ] Black-box and platform on-ramps: serve the world as REST, MCP and webhook tools for hosted agent platforms (#14), import voice-agent platform configs as draft domains (#34, #35), fault profiles (#15)

## Later
PR comments with pass^k deltas (#13), LLM-judged checks (#16), voice transport and timing metrics (#17, #43), exports to other harness formats (#18), negotiation invariants (#36), simulation clock (#38), outcome grading (#39), business metrics (#40), persona × condition matrix (#41), multi-session tasks (#42), Python agents in-process (#44).

## Good first issues
`$regex` in where clauses (#20).
