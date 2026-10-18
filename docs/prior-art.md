# Prior art

`sandtable` borrows its method from τ-bench and aims at a different job: rehearsing *one customer's* deployment, in that customer's repo, on every change. This page lists the closest projects and what each one is best at. If something here is out of date or unfair, please open an issue.

## Method

- **τ-bench / τ²-bench / τ³-bench** (Sierra Research, MIT). Introduced the setup `sandtable` uses: a policy, tools over a database, an LLM-simulated user with a hidden goal, grading on the final database state, and pass^k. Its airline, retail, telecom and banking domains are hand-built benchmarks for comparing models. Adding a domain means writing Python. Use it to compare models on public domains; use `sandtable` to build and gate a domain for your own customer. Exporting `sandtable` domains to τ-bench's format is on the roadmap.
- **τ^τ-bench (Hyper-τ)** (Sierra Research). Evaluates a coding agent that *builds* a customer-service agent from evidence (policies, transcripts, a client API), scored with τ³-bench. It benchmarks agent builders. It is not a tool for testing your own deployment.

## Open-source simulation frameworks

- **IntellAgent** (Plurai, Apache-2.0). Builds a policy graph from the agent's *system prompt*, generates scenarios with database state, simulates users and critiques the conversation. `sandtable` starts from the customer's artifacts instead of the agent's prompt, so a rule missing from the prompt still gets tested. It also grades deterministically rather than by critique.
- **LangWatch Scenario** (Apache-2.0). An SDK (Python and TS) for agent tests with a simulated user and a judge agent, inside pytest or vitest. Scenarios are hand-written code, judged mostly by an LLM. It pairs with the LangWatch platform.
- **DeepEval's ConversationSimulator** and **promptfoo's simulated-user provider**. Multi-turn simulation inside general eval frameworks. Strong metric libraries, with no stateful world or invariant model.
- **ArkSim** (Arklex, Apache-2.0). Simulated users with per-turn metrics and a CI gate.
- **Rehearsal / rehearsal-kit** (MIT, with a hosted service). Compiles a "practice world" from an application's source repository and container images, runs the real application in a sandbox with fictional data, grades outcomes against the application's own database, injects faults, and proposes improved agent versions. It is the closest in spirit. It fits best when you own the application's code and images. `sandtable` targets deployments where you only have what a customer hands over (API docs, SOPs, transcripts), and keeps the world declarative, local and in the repo.
- **Synkro** (MIT). Turns policy documents into conversation and tool-calling *datasets* (for evals or fine-tuning) rather than running an agent against a stateful world.

## Mock servers

**Prism, WireMock, Mockoon, Microcks** and newer agent-oriented mocks (**mockd**, **mockworld**, **faultbench**) simulate APIs. Most classic mocks are stateless or need hand-written state. `sandtable` keeps state minimal and declarative because its job is grading: the world is the thing being asserted on. A black-box mode that serves the world over REST and MCP is planned.

## Commercial platforms

- **Sierra** (simulations, Ghostwriter) and **Decagon** (Simulations, AOP versioning) generate tests from customer SOPs and transcripts and run them on every agent change, inside their own platforms.
- **Coval, Hamming, Cekura, Bluejay, Roark** and **Vapi Simulations** do simulation and regression testing for voice agents.
- **LangSmith, Braintrust** and similar platforms offer datasets, judges and CI gating for LLM apps generally.

## Where sandtable fits

| | sandtable | τ-bench | IntellAgent | Scenario |
|---|---|---|---|---|
| Your own domain | YAML in the repo | Python code | generated from the agent's prompt | test code |
| Stateful world | declarative tables | yes | generated database | bring your own |
| How a trial is graded | end state + invariants, no judge | end state + expected actions | LLM critique | judge agent + your asserts |
| Policy rules checked on every tool call | yes | no | no | no |
| pass^k across repeated trials | yes | yes | no | no |
| Agent integration | HTTP, JS/TS module, Claude | Python agents / LLM APIs | adapter | adapter function |
| Draft a domain from SOP + API + transcripts | planned (`init`) | no | from the system prompt | no |

Comparisons reflect the projects' public READMEs as of October 2026.
