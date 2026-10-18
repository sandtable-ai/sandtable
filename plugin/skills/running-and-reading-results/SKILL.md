---
name: running-and-reading-results
description: Runs a sandtable domain against an agent (Claude, any OpenAI-compatible or Bedrock model, an HTTP endpoint, a JS/TS module or the noop baseline), chooses k and reads pass^k, then reads results.json and report.html to find failure modes, attributes each failing trial to the agent under test, the simulated user, the task spec or the harness, and proposes fixes. Use when an engineer wants to rehearse or regression-test an agent with sandtable, compare models, gate CI on pass^k, or understand why trials failed or a score changed.
---

# Running sandtable and reading results

`sandtable run` puts a simulated user and the agent under test in a conversation, once per task per trial, each on a fresh copy of the world. Every trial is graded deterministically: the end state of the records, the tool-call log and the domain's invariants. No model judges pass or fail.

Run the CLI as `npx sandtable-ai <command>` (inside the sandtable repository: `node src/cli.ts <command>`). If a flag is rejected, trust `--help`.

## Why it is graded this way

- **Deterministic gates.** The customer's rules are deterministic ("never book a carrier with expired insurance"), so they are checked against records and tool calls. A transcript can sound right while the agent booked the wrong carrier; an LLM judge reading it misses that, and a judge's verdict changes between runs. A state check gives the same answer every time and can block a merge.
- **pass^k, not the average.** Customers meet every call, not the average one. pass^k is the probability that all k trials of a task pass, estimated per task as C(c, k) / C(n, k) from n trials with c passes, then averaged over tasks. pass^1 is the plain success rate. An agent that passes each trial 80% of the time passes 4 in a row only 41% of the time (0.8^4), and pass^4 shows that while pass^1 hides it.

## Choose the agent and the user

| `--agent` | What it is |
|---|---|
| `claude` (default), `claude:<model>` | the reference agent: Claude with the domain's tools and `policy.md` as its system prompt. Anthropic API (`ANTHROPIC_API_KEY`), or Bedrock with `--provider bedrock` |
| `openai:<model>` | the same prompt and tools on any OpenAI-compatible Chat Completions endpoint (OpenAI, OpenRouter, LiteLLM, vLLM, Ollama, …): for comparing models |
| `bedrock:<model-id>` | the same prompt and tools on a non-Claude Bedrock model through the Converse API, e.g. `bedrock:qwen.qwen3-32b-v1:0` |
| `http://…` or `https://…/step` | the engineer's agent as a service, speaking the step protocol (sandtable `docs/reference/http-protocol.mdx`) |
| `./my-agent.ts` or `./my-agent.js` | a module that default-exports an `AgentAdapter` (`.ts` needs Node ≥ 22.18) |
| `noop` | never calls a tool, declines everything: the do-nothing floor |

| `--user` | What it is |
|---|---|
| `claude` (default), `claude:<model>` | a simulated customer pursuing the task's hidden `user.instructions` |
| `openai:<model>` | the same simulated customer on an OpenAI-compatible endpoint |
| `scripted` | replays `user.script` line by line whatever the agent says: deterministic, free, good for wiring and grader checks |

The agent's tool names must match the domain's tool names: every tool call is run against the simulated world under that name.

Credentials and endpoints:
- `openai:` reads `OPENAI_API_KEY` and uses `--openai-base-url <url>`, else `OPENAI_BASE_URL`, else `https://api.openai.com/v1` (which requires the key; local servers such as Ollama do not). Agent and user share the endpoint, and the model must support tool calling on that server.
- `bedrock:` needs `npm install @aws-sdk/client-bedrock-runtime` (plus `@aws-sdk/credential-providers` when you pass `--aws-profile`), and takes `--region` and `--aws-profile`.
- `--provider bedrock --region <region> --aws-profile <name>` moves the Claude agent and user to Amazon Bedrock (`npm install @anthropic-ai/bedrock-sdk`).

**Comparing models.** Change only the agent: keep the same `--user`, k and tasks for every model, so differences come from the agent. Estimated cost covers Claude models only; others show `n/a`.

```bash
npx sandtable-ai run ./sandtable --agent claude --user claude -k 4 -o .sandtable/runs/claude
npx sandtable-ai run ./sandtable --agent openai:gpt-4.1-mini --user claude -k 4 -o .sandtable/runs/gpt-4.1-mini
```

## Run in this order

```bash
npx sandtable-ai validate ./sandtable --strict && npx sandtable-ai lint ./sandtable            # free: the suite is sound
npx sandtable-ai run ./sandtable --agent noop --user scripted                                   # free: the do-nothing floor
npx sandtable-ai run ./sandtable --agent http://localhost:8787/step --user scripted             # wiring: adapter, tool names, args
npx sandtable-ai run ./sandtable --agent http://localhost:8787/step -k 1                        # smoke with the Claude user
npx sandtable-ai run ./sandtable --agent http://localhost:8787/step -k 4 --fail-under 90        # reliability and the gate
```

- Runs with a model-backed agent or user cost money: say how many trials (tasks × k) and get the engineer's go-ahead. For Claude, the terminal shows an estimated cost at list prices after each run; use it to size the next one.
- `-t, --tasks a,b` reruns only some tasks. `-c, --concurrency <n>` (default 4) lowers parallelism when the API rate-limits.
- `--fail-under <pct>` exits 1 when pass^k (k = `-k`) is below the percentage. Put it in CI after `validate --strict` and `lint`.
- A scripted user cannot react, so a scripted run with a real agent tests wiring and graders, not conversation. Failures there can be the script's fault.
- To see sandtable work before touching a customer domain: `npx sandtable-ai demo` replays the bundled freight example offline (`--no-open` keeps the report closed). `demo --live` uses Claude as both sides, and costs money.

**Choosing k.** k = 1 finds outright failures. Use k ≥ 3 for a gate or a before/after comparison and say how many trials a number rests on: with 10 tasks, one flaky trial moves pass^k by up to 10 points. Compare runs only at the same k, the same tasks and the same user model.

## Compare models

Rank several agents on one domain under the same simulated callers, next to a do-nothing baseline:

```bash
npx sandtable-ai leaderboard examples/freight -m leaderboard/models.example.yaml -k 4 \
  --provider bedrock --region eu-west-1 --prices prices/bedrock.eu-west-1.json
```

- Keep the caller (`user:` in the models file) fixed across models, or the comparison is meaningless. Disclose which model plays the caller, since it may favour its own family.
- Re-running skips models whose results exist, so an interrupted run never pays twice. Pass `--no-resume` to redo one.
- Costs are estimates. Claude uses list prices, and `--prices` adds verified Bedrock prices from `scripts/bedrock-prices.mjs`. Anything else shows `n/a`; never fill it in by hand.

## Where the results are

`run` prints a summary, then writes to `.sandtable/runs/<timestamp>-<domain>/` (or `-o <dir>`):

- `results.json`: everything, including every trial's transcript, tool calls, checks and world diff. Read this one yourself with `jq`; [references/results-json.md](references/results-json.md) has the shape and ready-made queries.
- `report.html`: one self-contained file for people. Give the engineer the path, or pass `--open`. `npx sandtable-ai report <results.json> [-o out.html]` re-renders it.

Add `.sandtable/` to the project's `.gitignore` unless the engineer wants runs committed.

In the terminal summary and the report:
- a yellow **provisional** line or banner: drafted items are still pending review, so the score is not yet a claim about the customer's rules.
- per task, one mark per trial (✓ ✗) and passes/trials. Mixed marks mean a flaky task: the reliability gap pass^k exists to show.
- **By tag**: pass^1 and pass^k per tag. A high `refusal` score next to a low `happy-path` one is what a too-cautious agent looks like.
- **Top failure modes**: failed checks clustered across trials, most frequent first, each with an example.

## Read failing trials before trusting a score

Failure modes show what failed, not whose fault it was. Open the transcripts. In the first live freight run, most failures were the simulated caller's: it hung up right after accepting an offer, and it invented requests outside its goal. The score went from 70% to 95% by fixing the harness and one over-strict task, not the agent.

For each failing trial, find the **first** point where the trajectory leaves what the SOP and the task's `reference` describe, then attribute it:

| Owner | Typical evidence | Fix |
|---|---|---|
| **Harness** | `endReason: "error"` with a `runtime` check: HTTP 4xx/5xx from the agent endpoint, credentials, rate limits, a missing optional SDK, a task without `user.script` under `--user scripted`; or a reply of `[agent reply blocked by the provider's content filter]` / `[agent output was filtered]` | the adapter, endpoint, credentials, `-c`, the script or the provider's filter settings; rerun. Not a quality signal |
| **Simulated user** | user turns contradict `user.instructions`: invents needs, leaks the goal, accepts below its floor, hangs up before confirmation, never stops | rewrite `user.instructions` (explicit limits, explicit stop condition, what to do when refused); try a stronger `--user claude:<model>` |
| **Task spec** | the agent did what the SOP requires and a check still failed: over-strict `where`, a `not_called` the SOP allows, a missing seed row, a tool that does not model a side effect, a wrong invariant | fix the spec with the engineer, citing the SOP, then `lint` |
| **Agent** | the user behaved; the agent broke an invariant, skipped a required call, used wrong args, booked the wrong row, gave up, leaked a protected value, or looped until `[agent exceeded its tool-call budget for this turn]` (HTTP agents: `step budget`) | change the agent: its prompt, its tool use, its code. Leave the task alone |

The check kind is a hint, not a verdict. `invariant` failures are usually the agent's. `state` and `called` failures, and trials that ended at `max_turns`, need the transcript. `reply` failures are often a brittle phrase. [references/attribution.md](references/attribution.md) has the full procedure, signals per check kind, and worked examples. For a run with many failing trials, delegate the reading to the `failure-triager` agent so the transcripts stay out of the main conversation.

## Propose fixes, then prove them

1. Group failing trials by owner and root cause, and show the engineer the table: task, trial, owner, evidence (quote the event), proposed fix.
2. Make agent fixes in the agent's code or prompt. Do not edit tool descriptions in `sandtable.yaml` to help the agent unless the real tool's description changes too: the domain mirrors the customer's API.
3. Never make a score go up by weakening the suite: deleting a failing task, loosening an expectation the SOP supports, lowering k or `--fail-under`. A spec change needs a reason grounded in the SOP and the engineer's agreement.
4. Rerun the affected tasks at the same k, then the whole suite:

```bash
npx sandtable-ai run ./sandtable --agent http://localhost:8787/step --tasks walk-away-above-ceiling,expired-insurance -k 4
npx sandtable-ai run ./sandtable --agent http://localhost:8787/step -k 4 --fail-under 90
```

One passing rerun of a flaky task proves little. Report pass^1 and pass^k before and after, at the same k.

## References

- [references/results-json.md](references/results-json.md): the `results.json` shape and `jq` queries for failing trials, transcripts and violations.
- [references/attribution.md](references/attribution.md): attributing failures, with signals per check kind and worked examples.
