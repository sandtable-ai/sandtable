# Live results

Real runs of the bundled freight example and of `sandtable init`, kept here so claims in the README stay checkable. All runs used Claude on Amazon Bedrock (eu-west-1).

## Freight carrier sales, k=2 (October 2026)

Agent: Claude Opus 5.5 (reference agent, effort `medium`). Simulated caller: Claude Haiku 5.5.

This run used the example's first 10 tasks. The example has since grown to 32 tasks and 16 invariants (#45), so scores on the current suite are not comparable until it is rerun.

| | |
|---|---|
| pass^1 | **95.0%** |
| pass^2 | **90.0%** |
| trials | 20 (10 tasks × 2) |
| agent turn latency | p50 2.1 s · p95 5.8 s |
| estimated cost | $0.58 (list prices) |
| prompt cache | 297k tokens read from cache vs 480 uncached input tokens for the agent |

The only failure was an invariant violation, not a missed goal. In `walk-away-above-ceiling`, a firm caller refused every offer, and in one of two trials the agent answered "the best I can do is $1,450". That is the load's internal `max_rate`, which the SOP forbids revealing. `never_disclose` caught it deterministically. pass^2 falls below pass^1 because this leak is intermittent: exactly the reliability gap a single trial hides.

### What the first live runs taught us about the harness

The first full run scored 70% / 60%. Reading the failed transcripts showed that most failures were the simulator's fault, not the agent's:

- **Premature hang-ups.** The simulated caller accepted an offer and ended the call in the same message, so the agent never got to book. A closing message with content now gets one final agent turn, and the caller prompt says to wait for confirmation. Three tasks went from flaky to 2/2.
- **Invented needs.** The caller asked for a pickup address and a text confirmation that were not in its goal, and the agent correctly handed off. The caller prompt now forbids requests beyond the hidden goal. One over-strict task (it forbade any handoff, even after a correct booking) was relaxed to grade the booking itself.

The lesson: read failing trajectories before trusting a score. Automatic attribution of failures to the agent, the simulated user, the task or the infrastructure is tracked in the issues.

## `sandtable init` on the freight sources

Inputs: `examples/freight/source/openapi.yaml`, `examples/freight/policy.md`, two transcripts. Drafting model: Claude Opus 5.5.

- **OpenAPI → 4 tables and 5 tools**, deterministically, with two review notes: the 409 condition on booking, and the side effect "the load becomes booked".
- **SOP → 9 invariants**, each quoting its sentence. They cover all four hand-written rules:
  - verify before booking
  - carrier eligibility, split into four precise checks
  - rate ceiling
  - equipment match

  It also added two the hand-written domain lacked as invariants: load must be available, and `never_disclose` on `max_rate` with an exception for the booked rate. It noted 9 further rules as soft rules for future judged checks.
- **Transcripts → 2 tasks, 2 personas and 5 fictional seed rows.** Identities were fictionalised consistently across instructions, scripts, seed rows and expectations, and expectations follow the SOP rather than what the human rep did.
- **`sandtable lint`** then flagged both drafted tasks as not ready: they expect the load to become `booked`, but the drafted booking tool does not change loads yet. That is the side effect the OpenAPI step had flagged for review. Resolving that note makes them ready.
