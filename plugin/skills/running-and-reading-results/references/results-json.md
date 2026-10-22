# results.json

`sandtable run` writes one `results.json` per run, in `.sandtable/runs/<timestamp>-<domain>/` unless `-o` says otherwise. It holds every trial in full, so it is large: query it with `jq` instead of reading it whole.

```bash
RUN=$(ls -td .sandtable/runs/*/ | head -1)   # the latest run
R="$RUN/results.json"
```

## Shape

```text
SuiteResult
  version: 1
  sandtable                    { version, regradedWith? }: the sandtable-ai that ran the trials, and the one that
                               regraded them; absent before 0.3.0. `regrade` names `version` when it refuses a run
  domain, agent, user          names, e.g. "freight-carrier-sales"; "claude:claude-opus-5-5", "openai:gpt-4.1-mini",
                               "bedrock:qwen.qwen3-32b-v1:0", "http://localhost:8787/step", "noop", "scripted"
  k                            trials per task
  inputs                       hash of the agent's prompt and tool schemas and each task's caller prompt, opening and
                               turn limit; `sandtable regrade` re-scores the run only while they are unchanged
  startedAt, durationMs
  passHat                      { "1": 0.95, "2": 0.9 }: pass^1 .. pass^k, as fractions, over graded trials only;
                               a task with fewer than j graded trials is left out of pass^j (null if all are)
  passAt                       pass@1 .. pass@k, the same way: at least one of j trials passes
  flipRate                     share of tasks with 2+ graded trials that are flaky; null with k = 1
  flaky[]                      ids of flaky tasks (some graded trials passed, some failed)
  skipped                      trials skipped across the run; run exits 2 when it isn't 0
  callerNotes                  { turns, trials }: caller turns that stepped out of role, and the trials they are in
  byTag[]                      { tag, tasks, passHat1, passHatK }; "untagged" for tasks without tags
  failureModes[]               { id, kind, count, tasks[], example }: failed checks of graded trials clustered, most
                               frequent first; skipped trials' errors are not in it
  soft[]                       { id, description, tool?, applied, broken, rate, tasks[], example? }: one per soft
                               invariant; rate = broken / applied trials (null if it never applied). Never a failure
  pendingReview[]              { kind, id, source? }: non-empty means the run is provisional
  usage                        { agent: {<model>: tokens}, user: {<model>: tokens}, costUsd }: costUsd is null when a
                               model has no known price (Claude, or passed with --prices). tokens = { calls, input,
                               output, cacheRead, cacheWrite, maxTokensStops?, reasoningStripped?, emptyAfterStrip? }:
                               maxTokensStops counts replies cut off at the output-token limit, reasoningStripped
                               replies whose text held reasoning (<think>, <reasoning>, <analysis>…) removed before the
                               other side heard it, emptyAfterStrip replies that were only reasoning even after two
                               more tries, so the other side heard silence (a caller's "Hello?" after an empty agent
                               turn comes from this, not from the agent choosing to wait), each present only when
                               there was one. On Bedrock,
                               Claude usage is
                               keyed by the requested ID (global.anthropic.…, eu.anthropic.…; a geo profile costs 1.1×),
                               except an ARN, which keeps the bare name Claude reports at the global price; on the
                               Anthropic API by the model Claude reports
  latency                      { agentTurnP50Ms, agentTurnP95Ms }
  baseline?                    only with `run --baseline`: { runId, startedAt, agent, user, k, inputs?, passHat,
                               tasks[]: { id, passes, trials, inputs?, grading? } } of the run it was compared with
                               (trials counts graded trials); reports work out what changed from it
  tasks[]                      { id, description, tags[], critical?, passes, graded, skipped, verdict, interval?,
                               trials[] }: critical: true only on a critical task, which fails `run` when a graded
                               trial fails; verdict "passed" | "failed" | "flaky" | "skipped" over graded trials;
                               interval { low, high } is the 95% Wilson interval for passes / graded. Runs from
                               before verdicts lack these, and graded every trial. inputs? and grading? are short
                               hashes of the task's test: what the agent and caller are given (prompts, tools,
                               seed rows with given.rows, turn limit, script) and how it's graded (expect,
                               critical, every invariant). `--baseline` calls a task whose hash changed `changed`
    trials[]                   sorted by trial number
      taskId, trial            trial counts from 0
      passed                   false for a skipped trial too
      skipped?                 true when it ended in an error before the agent broke a hard invariant or called a
                               not_called tool: not graded, left out of the scores. Otherwise an error fails it
      endReason                "user_stop" | "max_turns" | "error"
      error?                   set when endReason is "error"
      turns, durationMs, usage
      checks[]                 { id, kind, passed, detail }
      violations[]             { invariant, description, detail, callIndex? | messageIndex? }: hard ones only
      soft[]                   { id, broken, violations[] }: soft invariants that applied in this trial
      callerNotes?             { turn, text, why }[]: caller turns that stepped out of role (talked about its
                               instructions, said its goal was met, or talked about the agent instead of to it).
                               turn counts the caller's turns from 1. Never changes passed
      events[]                 the transcript, in order:
                                 { type: "user", text }
                                 { type: "agent", text, latencyMs }
                                 { type: "tool", index, name, args, ok, result? | error?, violations[], soft? }
      changes[]                { table, key, kind: "insert" | "update", before?, after? }: the world diff
```

Check ids and kinds:

| `kind` | `id` looks like | Failed when |
|---|---|---|
| `invariant` | `verify-before-book` (the invariant id) | a tool call or agent message broke it |
| `state` | `state:bookings#1`, `state:loads[L-1002]#2` (table, key, position in `expect.state`) | the end state did not match |
| `called` | `called:transfer_to_human`, or `called:transfer_to_human(reason={"$contains":"billing"})` for an entry with `args` | the tool never succeeded (with `args`: no successful call matched them; the detail shows how the closest call differs) |
| `not_called` | `not_called:transfer_to_human`, or `not_called:book_load(load_id="L-1004")` for an entry with `args` | the tool was attempted (with `args`: with matching arguments) |
| `reply` | `reply:confirmation` | no agent message contained the phrase |
| `runtime` | `runtime` | the trial crashed: adapter, endpoint or simulator error. The trial is skipped unless an `invariant` or `not_called` check failed too |

## Queries

Headline numbers:

```bash
jq '{domain, agent, user, k, passHat, passAt, flipRate, skipped, provisional: (.pendingReview | length > 0), costUsd: .usage.costUsd, latency}' "$R"
```

Passes out of graded trials per task with its verdict, and flaky tasks (some trials pass, some fail) with their 95% interval:

```bash
jq -r '.tasks[] | "\(.passes)/\(.graded)  \(.verdict)  \(.id)"' "$R"
jq -r '.tasks[] | select(.verdict == "flaky") | "\(.id) \(.passes)/\(.graded) [\(.interval.low * 100 | round)%, \(.interval.high * 100 | round)%]"' "$R"
```

Critical tasks that failed a trial, the ones that made `run` exit 1:

```bash
jq -r '.tasks[] | select(.critical and .passes < (.graded // (.trials | length))) | "\(.id) \(.passes)/\(.graded // (.trials | length))"' "$R"
```

Failure modes, as in the terminal summary:

```bash
jq -r '.failureModes[] | "\(.count)x \(.kind) \(.id) [\(.tasks | join(", "))]\n    e.g. \(.example)"' "$R"
```

Every failing trial with its failed checks (skipped trials are listed below):

```bash
jq -r '.tasks[].trials[] | select((.passed or .skipped) | not) | "\(.taskId)#\(.trial) \(.endReason): " + ([.checks[] | select(.passed | not) | .id] | join(", "))' "$R"
```

Every invariant violation, with the call or message that broke it:

```bash
jq -r '.tasks[].trials[] | .taskId as $t | .trial as $n | .violations[] | "\($t)#\($n) \(.invariant): \(.detail)"' "$R"
```

The failed checks of one trial, then its transcript, with tool calls and violations inline (long tool results are cut to 200 characters):

```bash
jq -r --arg t expired-insurance --argjson n 0 '.tasks[] | select(.id == $t) | .trials[$n].checks[] | select(.passed | not) | "\(.id): \(.detail)"' "$R"
jq -r --arg t expired-insurance --argjson n 0 '
  .tasks[] | select(.id == $t) | .trials[$n].events[]
  | if .type == "tool" then
      "    [tool #\(.index)] \(.name)(\(.args | tojson)) -> "
      + (if .ok then (.result | tojson | .[0:200]) else "ERROR \(.error)" end)
      + (if (.violations | length) > 0 then "  VIOLATES \(.violations | join(", "))" else "" end)
    else "\(.type | ascii_upcase): \(.text)" end' "$R"
```

What one trial changed in the world:

```bash
jq '.tasks[] | select(.id == "expired-insurance") | .trials[0].changes[] | {kind, table, key, after}' "$R"
```

Soft invariants (`soft: true`): how often each was broken, and in which trials. They never fail a trial, so read them next to pass^k, not as failures:

```bash
jq -r '.soft[] | "\(.id): \(.broken) of \(.applied) trials \(if .rate == null then "" else "(\(.rate * 100 | round)%)" end)"' "$R"
jq -r '.tasks[].trials[] | .taskId as $t | .trial as $n | .soft[] | select(.broken) | "\($t)#\($n) \(.id): \(.violations[0].detail)"' "$R"
```

Trials that ran out of turns or crashed, and the skipped ones (crashed before the agent broke a rule, so not graded):

```bash
jq -r '.tasks[].trials[] | select(.endReason != "user_stop") | "\(.taskId)#\(.trial) \(.endReason) \(.error // "")"' "$R"
jq -r '.tasks[].trials[] | select(.skipped) | "\(.taskId)#\(.trial) \(.error)"' "$R"
```

A run made with `--baseline`: each task's passes in the baseline and now (the terminal summary and the report already list what broke and what got fixed):

```bash
jq -r '(.baseline.tasks | map({(.id): "\(.passes)/\(.trials)"}) | add) as $then
  | .tasks[] | "\(.id): \($then[.id] // "-") -> \(.passes)/\(.graded // (.trials | length))"' "$R"
```

Compare two runs task by task without rerunning (same k and tasks):

```bash
jq -rn --slurpfile a before/results.json --slurpfile b after/results.json '
  ($a[0].tasks | map({(.id): .passes}) | add) as $before
  | $b[0].tasks[] | "\(.id): \($before[.id] // "-") -> \(.passes) of \(.trials | length)"'
```
