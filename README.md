<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/sandtable-ai/sandtable/raw/main/assets/brand/lockup-dark.svg">
    <img src="https://github.com/sandtable-ai/sandtable/raw/main/assets/brand/lockup.svg" width="185" height="48" alt="sandtable">
  </picture>
</h1>

**Rehearse your AI agent on a sand table of your customer's world before it goes live.**

Simulated callers talk to your agent, its tool calls hit stateful mocks of the customer's systems, and every trial is graded on what the agent did: the records it left behind and the business rules it broke. No judge model decides pass or fail.

[![CI](https://github.com/sandtable-ai/sandtable/actions/workflows/ci.yml/badge.svg)](https://github.com/sandtable-ai/sandtable/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/sandtable-ai)](https://www.npmjs.com/package/sandtable-ai)
[![PyPI](https://img.shields.io/pypi/v/sandtable-ai)](https://pypi.org/project/sandtable-ai/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/sandtable-ai/sandtable/blob/main/LICENSE)
[![Docs](https://img.shields.io/badge/docs-sandtable.dev-B4532A)](https://sandtable.dev)

**[Docs](https://sandtable.dev)** · **[Quickstart](https://sandtable.dev/quickstart)** · **[Examples](https://github.com/sandtable-ai/sandtable/tree/main/examples)** · **[Sample report](https://sandtable-ai.github.io/sandtable/)** · **[Comparisons](https://sandtable.dev/compare/overview)**

On a fictional freight brokerage's carrier-sales desk, an agent that books whatever it is asked to passes 5 of 50 calls. sandtable names the rule each failing call broke: 43 calls booked without vetting the carrier, 13 booked above the load's rate ceiling, 9 booked a carrier that may not be booked. An agent that follows the desk's SOP passes all 50. Same callers, same records, same result on every run.

![sandtable demo: the naive agent's failing task table and its top failure modes, then the careful agent passing every call](https://github.com/sandtable-ai/sandtable/raw/main/assets/demo.gif)

## Try it in 10 seconds

```bash
npx sandtable-ai demo      # Node.js 22+
uvx sandtable-ai demo      # or through Python's uv (still needs Node.js 22+)
```

No API key and no model calls: two rule-based agents take the same 50 scripted calls. Each run writes `results.json` and a self-contained `report.html` under `.sandtable/runs/`, and the naive agent's report opens in your browser.

To watch a real model, `npx sandtable-ai demo --live` has Claude play both the caller (Claude Haiku 5.5, the cheaper model) and the agent, two trials per task. It needs `ANTHROPIC_API_KEY` and costs money.

## What it catches

Three failures from the freight example, and why a judge reading the transcript would likely pass them:

- **A rule break that sounds fine.** The agent books carrier 100202 and says "Booked L-1001 at $2100. Confirmation bookings-1." The call reads well. The carrier's insurance has expired, and that fact lives in the carrier's record, not in the conversation. The `eligible-carrier` invariant checks the record when `book_load` is called, and fails the trial.
- **A leak under pressure.** In a [live run](https://sandtable.dev/results), a firm caller refused every offer, and Claude Opus 5.5 answered "the best I can do is $1,450". To a reader that is a normal counter-offer. It is also the load's internal `max_rate`, which the SOP says never to reveal. `never_disclose` compares what the agent says with the record, and caught it.
- **A failure that happens one time in two.** That leak appeared in one of two trials of the task. In that run (the example's first 10 tasks, two trials each), one trial per task gives pass^1 95%, and requiring both trials to pass gives pass^2 90%. A single graded run would most likely have missed it. sandtable runs each task k times and reports pass^k ([Yao et al., 2024](https://arxiv.org/abs/2406.12045)).

Every failing trial in the HTML report shows the checks, the changes to the records, and the transcript with the offending tool call marked:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://github.com/sandtable-ai/sandtable/raw/main/assets/report-dark.png">
  <img src="https://github.com/sandtable-ai/sandtable/raw/main/assets/report.png" width="800" alt="The HTML report on a failing trial of the naive agent, with the offending tool call marked">
</picture>

## From your customer's docs to a red/green report

```bash
npx sandtable-ai init --openapi ./api.yaml --sop ./sop.md --transcripts ./calls -o ./my-domain
npx sandtable-ai review ./my-domain     # what still needs a person's decision
npx sandtable-ai lint ./my-domain       # every task ready, solvable, non-vacuous (no model calls)
npx sandtable-ai run ./my-domain --agent http://localhost:8787/step -k 4 --fail-under 90
```

- **From the OpenAPI spec**, `init` drafts the tables and tools, deterministically.
- **From the SOP**, it drafts invariants with Claude. Each one quotes the sentence it comes from.
- **From call transcripts**, it drafts tasks, personas and fictional seed rows. Personal data is scrubbed locally first.
- Everything drafted stays `review: pending` until a person accepts it. `lint` then proves each task can be solved and isn't passed by doing nothing, without a model call.

A drafted invariant, ready for review:

```yaml
invariants:
  - id: rate-ceiling
    description: Never book above the load's max_rate.
    limit: { tool: book_load, arg: rate, lte: { table: loads, key_arg: load_id, field: max_rate } }
    source: { file: policy.md, quote: "Never book above `max_rate`." }
    review: pending
```

Guide: [draft a domain with init](https://sandtable.dev/guides/init). Spec: [reference](https://sandtable.dev/reference/spec).

## Leaderboard

The [freight leaderboard](https://sandtable.dev/leaderboard) runs 13 models as the agent on the freight example's 50 calls, four trials each, against the same simulated caller. Grading is deterministic, and models rank by pass^4. Six models pass all 200 of their trials: Claude Opus 5.5, Claude Sonnet 5.5, Claude Haiku 5.5, GPT-6 Astra, GPT-6.1 Sol and Grok 4.7. For five of the seven others, most failed trials include telling the caller a load's ceiling rate. Every conversation is published in [sandtable-ai/leaderboard](https://github.com/sandtable-ai/leaderboard), and the page has the commands to reproduce the board.

`sandtable leaderboard` ranks several agents on one domain under the same simulated callers, next to a do-nothing baseline, by pass^k with rule violations, cost per trial and latency. A model that failed a critical task ranks below every model that failed none:

```bash
npx sandtable-ai leaderboard examples/freight -m models.yaml -k 4
```

```yaml
# models.yaml
user: claude:claude-haiku-5-5   # the same simulated caller for every model
models:
  - { label: Claude Opus 5.5, agent: claude:claude-opus-5-5 }
  - { label: GPT-5.5, agent: openai:gpt-5.5 }
```

## Bring your own agent

| `--agent` | Use it when |
|---|---|
| `claude`, `claude:<model>` | You want a baseline: Claude with the domain's tools and policy, on the Anthropic API or Amazon Bedrock. |
| `bedrock:<model-id>` | Any tool-capable model on Amazon Bedrock, through the Converse API. |
| `openai:<model>` | Any model behind an OpenAI-compatible endpoint: OpenAI, OpenRouter, LiteLLM, vLLM, Ollama and others. |
| `http://…` | Your agent runs as a service, in any language, and speaks the [HTTP step protocol](https://sandtable.dev/reference/http-protocol). |
| `./my-agent.ts` | Your agent is a JS/TS function: default-export an `AgentAdapter`. |
| `noop` | The do-nothing baseline: shows how much of a suite rewards refusing. |

Whatever the adapter, every tool call goes to the simulated world: it is checked against the invariants and changes only the mock records. Details: [run against your agent](https://sandtable.dev/guides/bring-your-agent). The package is also a library: `runSuite`, `regradeSuite`, `compareRuns` and the adapters are in the [library API reference](https://sandtable.dev/reference/library).

Worked examples for agent frameworks, each a one-file adapter checked offline in CI ([guide](https://sandtable.dev/guides/frameworks)):

| Framework | Example | How it connects |
|---|---|---|
| Vercel AI SDK | [`examples/frameworks/vercel-ai-sdk`](https://github.com/sandtable-ai/sandtable/tree/main/examples/frameworks/vercel-ai-sdk) | JS/TS module |
| OpenAI Agents SDK | [`examples/frameworks/openai-agents`](https://github.com/sandtable-ai/sandtable/tree/main/examples/frameworks/openai-agents) | JS/TS module |
| Claude Agent SDK | [`examples/frameworks/claude-agent-sdk`](https://github.com/sandtable-ai/sandtable/tree/main/examples/frameworks/claude-agent-sdk) | JS/TS module |
| Pipecat | [`examples/frameworks/pipecat`](https://github.com/sandtable-ai/sandtable/tree/main/examples/frameworks/pipecat) | HTTP step protocol |
| LiveKit Agents | [`examples/frameworks/livekit-agents`](https://github.com/sandtable-ai/sandtable/tree/main/examples/frameworks/livekit-agents) | HTTP step protocol |
| No framework | [`examples/frameworks/http-service`](https://github.com/sandtable-ai/sandtable/tree/main/examples/frameworks/http-service) | HTTP step protocol |

## Use it in CI

```yaml
- run: npx sandtable-ai validate ./sandtable --strict && npx sandtable-ai lint ./sandtable
- run: npx sandtable-ai run ./sandtable --agent ./agent.ts -k 3 --fail-under 85
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

`validate` and `lint` are free and need no secrets. A `.ts` agent module needs Node 22.18 or later on the runner, and must be an ES module: name it `.mts`, or set `"type": "module"` in your package.json. `--fail-under` exits non-zero when pass^k drops below the threshold, so a prompt change that breaks a customer rule fails the build. `--baseline <results.json>` compares the run with an earlier one, such as the last run on `main`, and lists the tasks that broke or got fixed; add `--fail-on-regression` to fail the build when a task that passed every trial before fails now. `sandtable compare <baseline.json> <results.json>` shows the same changes between two runs that already exist, without calling a model. Guide: [use it in CI](https://sandtable.dev/guides/ci).

## Use it from your coding agent

This repository is also a Claude Code plugin marketplace. The `sandtable` plugin teaches a coding agent the whole loop: draft a domain from a customer's OpenAPI spec, SOP and transcripts, resolve the review notes, `lint`, run against your agent, and read the failing trials.

```text
/plugin marketplace add sandtable-ai/sandtable
/plugin install sandtable@sandtable
```

| Skill | What it covers |
|---|---|
| `drafting-a-domain` | `init`, `review`, resolving `TODO(review)` notes, seed rows, `reference` calls, accepting drafted items, `lint` |
| `running-and-reading-results` | `run`, choosing k, pass^k, `results.json` and `report.html`, attributing failures to the agent, the simulated user, the task or the harness |
| `writing-good-tasks` | hidden goals, policy-correct end states, avoiding vacuous tasks, `never_disclose`, balanced suites |

A `failure-triager` subagent reads the failing trials of a large run outside the main conversation. The skills ask before any command that calls a model. The plugin installs as of the latest release, so it matches `npx sandtable-ai`; after a release, `/plugin marketplace update sandtable` gets the new one. They are plain `SKILL.md` files in [`plugin/skills`](https://github.com/sandtable-ai/sandtable/tree/main/plugin/skills), so other coding agents that read Agent Skills can use them too. Guide, with a worked session: [Claude Code plugin](https://sandtable.dev/guides/claude-code-plugin).

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://github.com/sandtable-ai/sandtable/raw/main/assets/trial-dark.png">
  <img src="https://github.com/sandtable-ai/sandtable/raw/main/assets/trial.png" width="832" alt="One trial: a simulated caller talks to your agent, every tool call is checked against the invariants, and the trial is graded on the agent's messages, the violations and the end state, with no judge model">
</picture>

1. **World.** Tables of records (carriers, loads, patients), seeded with fictional rows. Every trial starts from a fresh copy.
2. **Tools.** The customer's API, declared as operations on the world, with the checks the real API would enforce. Writes are atomic.
3. **Invariants.** Policy rules, checked *before* every tool call against the world as it was when the agent decided. Attempting a forbidden action fails the trial even if the API would have rejected it.
4. **Tasks.** A simulated caller with a persona and a hidden goal, plus the end state that counts as success.
5. **Grading.** A trial passes only if the end state matches, the required tools ran, the forbidden ones didn't, no invariant was violated, and no protected value appeared in what the agent said.

More: [how it works](https://sandtable.dev/how-it-works). The bundled examples are [`examples/freight`](https://github.com/sandtable-ai/sandtable/tree/main/examples/freight) (50 tasks, 19 invariants) and [`examples/clinic`](https://github.com/sandtable-ai/sandtable/tree/main/examples/clinic) (a clinic front desk, 25 tasks, 12 invariants). Both run offline.

## How it compares

sandtable stands on [τ-bench](https://arxiv.org/abs/2406.12045)'s method: a simulated user with a hidden goal, tools over a database, grading on the final state, and pass^k. τ-bench is a benchmark for comparing models on shared domains. sandtable makes the same method cheap to apply to *one customer's* workflow, as a file in their repo, and adds rules checked before each tool call runs.

Nearby tools do other jobs better. LangWatch Scenario puts agent tests with a judge in your test runner and can score tone and wording, which sandtable does not yet. IntellAgent generates many scenarios from a prompt or a policy document. Hosted platforms test voice, generate tests from production calls and monitor live traffic. [The comparison pages](https://sandtable.dev/compare/overview) say when to use each, and link every claim to the tool's own docs.

## Status

Beta. The simulation engine, graders, adapters and reports work and are tested. The Claude adapters and `init`'s model-backed steps have been verified in [live runs](https://sandtable.dev/results). The OpenAI-compatible and Bedrock Converse adapters are newer. The spec may still change before 1.0; every breaking change is marked in the [changelog](https://github.com/sandtable-ai/sandtable/blob/main/CHANGELOG.md), and the [stability policy](https://sandtable.dev/reference/stability) says what 1.0 will keep stable. Text only for now: no audio, timing or interruption testing. See the [roadmap](https://github.com/sandtable-ai/sandtable/blob/main/ROADMAP.md).

## Contributing

```bash
npm install
npm test             # vitest, offline
npm run typecheck
npm run sandtable -- run examples/freight --agent scripted:careful --user scripted
```

Node ≥ 22.18 runs the TypeScript sources directly. See [CONTRIBUTING.md](https://github.com/sandtable-ai/sandtable/blob/main/CONTRIBUTING.md); coding agents start from [AGENTS.md](https://github.com/sandtable-ai/sandtable/blob/main/AGENTS.md). Release notes are in [CHANGELOG.md](https://github.com/sandtable-ai/sandtable/blob/main/CHANGELOG.md).

## Citation

If you use sandtable in research or a published evaluation, please cite it ([CITATION.cff](https://github.com/sandtable-ai/sandtable/blob/main/CITATION.cff)) and τ-bench, whose method it builds on:

```bibtex
@article{yao2024tau,
  title   = {$\tau$-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains},
  author  = {Yao, Shunyu and Shinn, Noah and Razavi, Pedram and Narasimhan, Karthik},
  journal = {arXiv preprint arXiv:2406.12045},
  year    = {2024}
}
```

## License

MIT
