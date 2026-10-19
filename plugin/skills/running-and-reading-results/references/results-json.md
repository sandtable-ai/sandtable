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
  domain, agent, user          names, e.g. "freight-carrier-sales"; "claude:claude-opus-5-5", "openai:gpt-4.1-mini",
                               "bedrock:qwen.qwen3-32b-v1:0", "http://localhost:8787/step", "noop", "scripted"
  k                            trials per task
  startedAt, durationMs
  passHat                      { "1": 0.95, "2": 0.9 }: pass^1 .. pass^k, as fractions
  byTag[]                      { tag, tasks, passHat1, passHatK }; "untagged" for tasks without tags
  failureModes[]               { id, kind, count, tasks[], example }: failed checks clustered, most frequent first
  soft[]                       { id, description, tool?, applied, broken, rate, tasks[], example? }: one per soft
                               invariant; rate = broken / applied trials (null if it never applied). Never a failure
  pendingReview[]              { kind, id, source? }: non-empty means the run is provisional
  usage                        { agent: {<model>: tokens}, user: {<model>: tokens}, costUsd }: costUsd is null when a
                               model has no known price (Claude, or passed with --prices)
  latency                      { agentTurnP50Ms, agentTurnP95Ms }
  tasks[]                      { id, description, tags[], passes, trials[] }
    trials[]                   sorted by trial number
      taskId, trial            trial counts from 0
      passed
      endReason                "user_stop" | "max_turns" | "error"
      error?                   set when endReason is "error"
      turns, durationMs, usage
      checks[]                 { id, kind, passed, detail }
      violations[]             { invariant, description, detail, callIndex? | messageIndex? }: hard ones only
      soft[]                   { id, broken, violations[] }: soft invariants that applied in this trial
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
| `called` | `called:transfer_to_human` | the tool never succeeded |
| `not_called` | `not_called:transfer_to_human` | the tool was attempted |
| `reply` | `reply:confirmation` | no agent message contained the phrase |
| `runtime` | `runtime` | the trial crashed: adapter, endpoint or simulator error |

## Queries

Headline numbers:

```bash
jq '{domain, agent, user, k, passHat, provisional: (.pendingReview | length > 0), costUsd: .usage.costUsd, latency}' "$R"
```

Passes per task, and flaky tasks (some trials pass, some fail):

```bash
jq -r '.tasks[] | "\(.passes)/\(.trials | length)  \(.id)"' "$R"
jq -r '.tasks[] | select(.passes > 0 and .passes < (.trials | length)) | "\(.id) \(.passes)/\(.trials | length)"' "$R"
```

Failure modes, as in the terminal summary:

```bash
jq -r '.failureModes[] | "\(.count)x \(.kind) \(.id) [\(.tasks | join(", "))]\n    e.g. \(.example)"' "$R"
```

Every failing trial with its failed checks:

```bash
jq -r '.tasks[].trials[] | select(.passed | not) | "\(.taskId)#\(.trial) \(.endReason): " + ([.checks[] | select(.passed | not) | .id] | join(", "))' "$R"
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

Trials that ran out of turns or crashed:

```bash
jq -r '.tasks[].trials[] | select(.endReason != "user_stop") | "\(.taskId)#\(.trial) \(.endReason) \(.error // "")"' "$R"
```

Compare two runs task by task (same k and tasks):

```bash
jq -rn --slurpfile a before/results.json --slurpfile b after/results.json '
  ($a[0].tasks | map({(.id): .passes}) | add) as $before
  | $b[0].tasks[] | "\(.id): \($before[.id] // "-") -> \(.passes) of \(.trials | length)"'
```
