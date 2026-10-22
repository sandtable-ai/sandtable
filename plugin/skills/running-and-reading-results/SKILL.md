---
name: running-and-reading-results
description: Runs a sandtable domain against an agent (Claude, any OpenAI-compatible or Bedrock model, an HTTP endpoint, a JS/TS module or the noop baseline), chooses k and reads pass^k, then reads results.json and report.html to find failure modes, attributes each failing trial to the agent under test, the simulated user, the task spec or the harness, and proposes fixes. Use when an engineer wants to rehearse or regression-test an agent with sandtable, compare models, gate CI (--fail-under on pass^k, critical release-blocker tasks, exit 1 for a failed gate and 2 for an error), or understand why trials failed or a score changed.
---

# Running sandtable and reading results

`sandtable run` puts a simulated user and the agent under test in a conversation, once per task per trial, each on a fresh copy of the world. Every trial is graded deterministically: the end state of the records, the tool-call log and the domain's invariants. No model judges pass or fail.

Run the CLI as `npx sandtable-ai <command>` (inside the sandtable repository: `node src/cli.ts <command>`). If a flag is rejected, trust `--help`. Learn what the CLI supports from `--help` and `validate`, never from sandtable's code in `node_modules/sandtable-ai` or npx's cache. Only if a command fails with `node: OpenSSL configuration error` and `openssl.cnf … Operation not permitted`, Claude Code's sandbox blocked Node from reading its OpenSSL config: rerun that command with `OPENSSL_CONF=/dev/null` in front, e.g. `OPENSSL_CONF=/dev/null npx sandtable-ai validate ./sandtable`. Don't add it otherwise.

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
- `bedrock:` needs `@aws-sdk/client-bedrock-runtime` (plus `@aws-sdk/credential-providers` when you pass `--aws-profile`), and takes `--region` and `--aws-profile`.
- `--provider bedrock --region <region> --aws-profile <name>` moves the Claude agent and user to Amazon Bedrock (needs `@anthropic-ai/bedrock-sdk`).
- Optional packages work only next to `sandtable-ai` in the same project (`npm install --save-dev sandtable-ai <package>`); `npx sandtable-ai` can't see one installed on its own. One-off: `npx -p sandtable-ai -p <package> sandtable <command>`.

**Comparing models.** Change only the agent: keep the same `--user`, k and tasks for every model, so differences come from the agent. Estimated cost covers Claude models, plus any model whose prices you pass with `--prices`; others show `n/a`.

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
- `run` also exits 1, with or without `--fail-under`, when any trial of a `critical: true` task fails, and names those tasks. Reports list critical tasks first.
- A failed gate exits 1 and an error exits 2: a usage error, a missing file, an invalid domain, an adapter that can't be built, a run in which every trial errored or some were skipped. Read a 2 as "fix the setup and rerun", not as a verdict on the agent.
- `--baseline <results.json>` compares the run with an earlier one of the same domain: it lists the tasks that broke or got fixed, new failures first, and pass^1 and pass^k before and after, and the report opens with the same. A task whose test changed since (its prompts, tools, seed rows or grading) is `~ changed`, never credited as fixed or broken, and left out of pass^k. After editing grading, regrade the baseline under the edited domain and compare against that. It never changes the exit code.
- A scripted user cannot react, so a scripted run with a real agent tests wiring and graders, not conversation. Failures there can be the script's fault.
- To see sandtable work before touching a customer domain: `npx sandtable-ai demo` replays the bundled freight example offline (`--no-open` keeps the report closed). `demo --live` uses Claude as both sides, and costs money.

**Choosing k.** k = 1 finds outright failures. Use k ≥ 3 for a gate or a before/after comparison and say how many trials a number rests on: with 10 tasks, one flaky trial moves pass^k by up to 10 points. Compare runs only at the same k, the same tasks and the same user model.

## Compare models

Rank several agents on one domain under the same simulated callers, next to a do-nothing baseline. Write the models file in the user's project; agent specs are the same as `run --agent`:

```yaml
# models.yaml
user: claude:claude-haiku-5-5
models:
  - { label: Claude Opus 5.5, agent: claude:claude-opus-5-5 }
  - { label: GPT-5.5, agent: bedrock:global.openai.gpt-5.5 }
```

```bash
npx sandtable-ai leaderboard ./sandtable -m models.yaml -k 4 --provider bedrock --region eu-west-1
```

- Keep the caller (`user:` in the models file) fixed across models, or the comparison is meaningless. Disclose which model plays the caller, since it may favour its own family.
- A `claude:` entry can set `effort: low|medium|high|xhigh|max` (default `medium`; an effort on any other agent is an error). Say which effort each Claude model ran at: `run.json` records it, the board shows it next to the model's name, and results stored at another effort aren't reused.
- Re-running reuses models whose results exist for the same agent spec, domain, k, caller and tasks, on the same provider and region, and runs the models with none, so an interrupted run never pays twice. Stored results that don't match are never replaced: the board stops before it runs anything and lists each model and why. So give a cheap check of a few tasks (`-t <ids>`) or another `-k` its own `-o`. A `--provider` or `--region` change concerns only the models whose calls go there, and any one of them stops the whole board: Claude models for the provider, Bedrock models for the region. With a Claude caller, a provider change concerns every model, and so does a region change when that caller runs on Bedrock. So does a change to what the agent or the caller is given (the policy, a tool, a task's caller instructions). To rerun one model, move or delete its folder; `--no-resume` reruns every model and replaces all their results. Without a region from `--region`, `AWS_REGION`, `AWS_DEFAULT_REGION` or the AWS profile, a board that uses Bedrock stops before it runs anything. Stored conversations are graded again under the domain's current rules, so an edit to an invariant or an expectation updates every model without a model call (`↻ regraded`).
- A model whose agent can't be built, or with any crashed trial, shows as `✗ failed` and an `error` row, never a score. When every model fails, the board ranks nothing and `leaderboard` exits 2: read each `✗ failed` line (missing credentials or package, the wrong `--provider` or `--region`, throttling, an agent that isn't running) before rerunning. The do-nothing baseline doesn't count.
- Before recommending a model from a board, attribute every failure of the top candidates: hand each model's `results.json` (in its folder under the board's output directory) and the domain to the `failure-triager` agent. A board ranks failures, not owners, so a cheaper model's only failure may be the task's fault, and then the ranking says nothing about the models. Fix the task, rerun it for every model, and compare again.
- Costs are estimates. Claude uses list prices, at 1.1× on a Bedrock geo profile (`eu.`, `us.`, `apac.`), the regional premium Anthropic publishes; a `global.` profile pays the list price. And `--prices <file>` adds verified prices for other models (`{ "<model-id>": { input, output, cacheRead, cacheWrite } }` in USD per million tokens; for Bedrock, `scripts/bedrock-prices.mjs` in the sandtable repo writes the file from the AWS Pricing API, and takes models the Pricing API doesn't list from `prices/bedrock.verified.json` with `--verified`: prices copied from AWS's model pages, each with its source URL). Anything else shows `n/a`; never invent a price or add one without a source.

## Where the results are

`run` prints a summary, then writes to `.sandtable/runs/<timestamp>-<domain>/` (or `-o <dir>`):

- `results.json`: everything, including every trial's transcript, tool calls, checks and world diff. Read this one yourself with `jq`; [references/results-json.md](references/results-json.md) has the shape and ready-made queries.
- `report.html`: one self-contained file for people. Give the engineer the path, or pass `--open`. `npx sandtable-ai report <results.json> [-o out.html]` re-renders it.

Add `.sandtable/` to the project's `.gitignore` unless the engineer wants runs committed.

In the terminal summary and the report:
- a **provisional** line (yellow in the terminal) or banner: drafted items are still pending review, so the score is not yet a claim about the customer's rules.
- per task, one mark per trial (✓ passed, ✗ failed, ○ skipped) and passes out of graded trials. `flaky` marks a task that passed some trials and failed others: the reliability gap pass^k exists to show. With k > 1, the headline adds pass@k (at least one of k trials passes) and the flip rate (the share of tasks that are flaky), and **Flaky tasks** lists them with a 95% interval for each one's pass rate. With few trials it is wide: say so before calling a change real.
- **Skipped trials**: trials that ended in an error (throttling or a timeout that outlasted the retries, an agent endpoint that went down) before the agent broke any rule. They are left out of the scores, and `run` exits 2 because the run is incomplete: fix the cause (credentials, `--concurrency`, the agent's service) and rerun before reading the score. A trial that broke a rule before its error is failed, not skipped.
- **Caller notes**: caller turns where the simulated user stepped out of its role (talked about its instructions, said its goal was met, or talked about the agent instead of to it). They never change a verdict; read those trials first, since the agent heard them.
- **By tag**: pass^1 and pass^k per tag. A high `refusal` score next to a low `happy-path` one is what a too-cautious agent looks like.
- **Soft rules**, when the domain has `soft: true` invariants: how often each was broken, out of the trials where it applied. They never fail a trial, so read them next to pass^k: in the freight example, `counter-at-ceiling` is how often the agent's counter-offers reached the price ceiling.
- **Top failure modes**: failed checks clustered across trials, most frequent first, each with an example.

## Read failing trials before trusting a score

Failure modes show what failed, not whose fault it was. Open the transcripts. In the first live freight run (on the example's first 10 tasks), most failures were the simulated caller's: it hung up right after accepting an offer, and it invented requests outside its goal. The score went from 70% to 95% by fixing the harness and one over-strict task, not the agent.

For each failing trial, find the **first** point where the trajectory leaves what the SOP and the task's `reference` describe, then attribute it:

| Owner | Typical evidence | Fix |
|---|---|---|
| **Harness** | `endReason: "error"` with a `runtime` check: HTTP 4xx/5xx from the agent endpoint, credentials, rate limits, a missing optional SDK, a task without `user.script` under `--user scripted`; or a reply of `[agent reply blocked by the provider's content filter]` / `[agent output was filtered]` | the adapter, endpoint, credentials, `-c`, the script or the provider's filter settings; rerun. Not a quality signal |
| **Simulated user** | user turns contradict `user.instructions`: invents needs or facts (trials of one task answer the same question differently), leaks the goal, accepts below its floor, hangs up before confirmation, never stops; the trial's `callerNotes` | rewrite `user.instructions` (explicit limits, explicit stop condition, what to do when refused, every fact the agent will ask about); try a stronger `--user claude:<model>` |
| **Task spec** | the agent did what the SOP requires and a check still failed: over-strict `where`, a `not_called` the SOP allows, a missing seed row, a tool that does not model a side effect, a wrong invariant | fix the spec with the engineer, citing the SOP, then `lint` |
| **Agent** | the user behaved; the agent broke an invariant, skipped a required call, used wrong args, booked the wrong row, gave up, leaked a protected value, or looped until `[agent exceeded its tool-call budget for this turn]` (HTTP agents: `step budget`) | change the agent: its prompt, its tool use, its code. Leave the task alone |

The check kind is a hint, not a verdict. `invariant` failures are usually the agent's, but check the rule first: read the invariant's `source.quote` in `sandtable.yaml` and confirm the SOP requires what the rule checks (the same order of calls, the same bound, the same condition). A rule stricter than its quote is the task spec's fault, even when the agent clearly broke it: relax the rule or make it `soft: true`, and confirm with `regrade`. `state` and `called` failures, and trials that ended at `max_turns`, need the transcript. `reply` failures are often a brittle phrase. [references/attribution.md](references/attribution.md) has the full procedure, signals per check kind, and worked examples. For a run with many failing trials, delegate the reading to the `failure-triager` agent so the transcripts stay out of the main conversation.

## Propose fixes, then prove them

1. Group failing trials by owner and root cause, and show the engineer the table: task, trial, owner, evidence (quote the event), proposed fix.
2. Make agent fixes in the agent's code or prompt. Do not edit tool descriptions in `sandtable.yaml` to help the agent unless the real tool's description changes too: the domain mirrors the customer's API.
3. Never make a score go up by weakening the suite: deleting a failing task, loosening an expectation the SOP supports, lowering k or `--fail-under`. A spec change needs a reason grounded in the SOP and the engineer's agreement.
4. Confirm each fix the cheapest way that proves it. What the fix changed decides the command:

| The fix changed | Confirm with |
|---|---|
| only grading: an invariant (`soft: true` included), an `expect` entry, a `never_disclose` rule | `regrade`: it re-scores the stored trials under the edited domain without a model call, and prints each verdict that changed and pass^k before and after |
| what the agent or the caller is given: `policy.md`, a tool, a task's `user` block (instructions, opening, script), its persona, `given.context` or turn limit; or the agent's own prompt or code | a rerun of only those tasks, at the same k. `regrade` refuses the run, since the conversation could have gone otherwise |
| seed rows, `given.rows` or a tool's ops | `regrade` first: it replays every stored tool call and stops at the first one that now returns something else. Then rerun those tasks |

```bash
npx sandtable-ai regrade .sandtable/runs/<run>/results.json -d ./sandtable -o .sandtable/runs/regraded   # free: grading-only fixes
npx sandtable-ai run ./sandtable --agent http://localhost:8787/step --tasks walk-away-above-ceiling,expired-insurance -k 4
npx sandtable-ai run ./sandtable --agent http://localhost:8787/step -k 4 --fail-under 90
```

When one triage finds both kinds, fix grading first and regrade, then change the caller's instructions and rerun those tasks: `regrade` refuses the whole run, not just one task, once any task's caller prompt changed. Pass `-o` to `regrade`, or it replaces the run's own `results.json`, which you need as the baseline.

One passing rerun of a flaky task proves little. Report pass^1 and pass^k before and after, at the same k: pass the run from before the fix as `--baseline <results.json>`, and the summary lists which tasks broke or got fixed.

## References

- [references/results-json.md](references/results-json.md): the `results.json` shape and `jq` queries for failing trials, transcripts and violations.
- [references/attribution.md](references/attribution.md): attributing failures, with signals per check kind and worked examples.
