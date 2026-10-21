# Attributing failures

A failed trial means some check failed. It does not say whose fault that is. Four parties can cause it, and each needs a different fix:

- **Agent**: the system under test. The only party whose failures should lower confidence in going live.
- **Simulated user**: a model playing the customer from `user.instructions`. It can misbehave like any model.
- **Task spec**: the domain and the task: seed rows, tools, invariants and expectations. A person wrote or accepted them, and they can be wrong.
- **Harness**: adapters, endpoints, credentials, rate limits, timeouts.

Fixing the wrong party is the expensive mistake. Tuning the agent's prompt to satisfy an over-strict task makes it worse for the real customer. Relaxing a task to excuse a real agent bug ships the bug.

## Procedure

For each failing trial (see results-json.md for the queries):

1. **Read the failed checks.** Note the kinds and details.
2. **Rule out the harness.** `endReason: "error"` or a `runtime` check means the conversation did not finish normally. Read `error`. When nothing else failed first, the trial is `skipped`, already left out of the scores, and the run is incomplete. Fix and rerun before judging anything else.
3. **Read the task.** Its `user.instructions`, `expect` and `reference` in `tasks.yaml`, and the SOP sections it touches. Know what a correct conversation looks like before you read this one.
4. **Read the transcript in order** and stop at the first divergence: the first turn where the user or the agent does something the instructions or the SOP do not call for. Later problems usually follow from it.
5. **Ask who diverged.**
   - The user turn contradicts `user.instructions` → **simulated user**. Start with the trial's `callerNotes`: turns where the caller talked about its instructions or about the agent instead of to it. Also look for facts the caller gave that its instructions don't state (an item's condition, a receipt, a date): two trials of one task that answer such a question differently are caller guesses, not the agent's doing. Fix the task by stating the fact in `user.instructions`.
   - The agent turn or tool call contradicts the SOP while the user behaved → **agent**.
   - Nobody diverged, and a check still failed → **task spec**.
6. **Look at sibling trials.** A task that fails in some trials and passes in others is flaky. Compare a passing and a failing trial of the same task: the difference is usually the divergence.
7. **Write it down**: task, trial, owner, the event that shows it (quote it), proposed fix.

## Signals by check kind

### `invariant`
The agent attempted a forbidden call or said a protected value. Usually the **agent**. Before blaming it:
- Is the invariant right? Reread its `source.quote`. A drafted invariant with the wrong bound or condition fails correct agents.
- Did the user ask for the forbidden thing in a way the SOP says to refuse? Then it is still the agent: refusing is its job.
- `never_disclose`: does the flagged value also mean something legitimate? If another row's `posted_rate` equals some load's `max_rate`, a correct agent quoting the posted rate trips it, once a tool result in the call has shown that load. A value counts only after the agent was shown it, so a ceiling of a load it never looked up can't trip it. That is a **task spec** problem: make seed values distinct. A detail that says the value was said `next to "<word>"` comes from `never_with`: read the sentence, since a word with another meaning there ("under the weight limit") is a false positive, also a task spec problem.

### `state`
The world did not end as expected. Read `changes` and the transcript:
- The agent never attempted the write, or wrote the wrong row, while the user asked clearly → **agent**.
- The tool call failed with a tool error the real API would not return, or succeeded where the real API would refuse → **task spec** (tool modelling).
- The user never asked, gave up early, or accepted something outside its goal → **simulated user**.
- The agent did what the SOP says, and the expectation wants something else (an exact rate where the SOP allows a band, a row the SOP would not create) → **task spec**.

### `called` / `not_called`
- `called` failed: did the agent skip the step, or did the conversation never reach it because the user hung up?
- `called` with `args` failed: the detail shows how the closest successful call differs. Other arguments the SOP forbids (the wrong load, the wrong carrier) → **agent**. Other arguments the SOP allows (a different but valid reason, a rate inside the band) → **task spec**: loosen the matcher with an operator or drop the condition.
- `not_called` failed: does the SOP really forbid that call in this situation? An over-broad `not_called` (forbidding a handoff the SOP allows) is a **task spec** problem.

### `reply`
Phrase matching is brittle. If the agent conveyed the same thing in other words, it is the **task spec**: replace the phrase with a state check, or drop it.

### `endReason: "max_turns"`
- The agent loops (repeats questions, keeps calling tools) → **agent**.
- The user never stops although its goal is met or impossible → **simulated user**: add an explicit stop condition to `user.instructions`.

### Agent budget messages
`[agent exceeded its tool-call budget for this turn]` (the `claude`, `openai:` and `bedrock:` adapters, after 12 model calls in one user turn) and `[agent exceeded its step budget for this turn]` (the HTTP adapter, after 16 steps) mean the agent kept calling tools without answering. Usually the **agent**. Check whether a tool kept returning an error the real API would not (then **task spec**).

### Provider replies
`[agent reply blocked by the provider's content filter]` (`openai:`) and `[agent output was filtered]` (`bedrock:` guardrails) mean the provider blocked the reply, and `[agent refused]` means Claude declined. A filter on an ordinary customer request is a **harness** or deployment setting to fix before judging the agent; if production runs behind the same filter, tell the engineer, because customers will meet it too.

## Worked examples

These follow runs of the bundled, fictional freight domain: the first live runs recorded in the sandtable repository's `docs/results.mdx`, and the offline `scripted:naive` agent.

**The caller hung up on its own deal.** A negotiation task failed its booking check. The user's last turn accepted the offer and ended the call in the same message (something like "Deal, book it. Bye!"), so the agent never had a turn to book. Owner: **simulated user**, plus the harness, which now gives the agent one final turn after a closing message with content. Fix: a stop condition in the instructions, "once you have a confirmation number, say thanks and end the call".

**The caller invented a need.** The user asked for a pickup address and a text confirmation, neither in its instructions. The agent correctly handed off to a human, and the task, which forbade any handoff, failed. Two owners: the **simulated user** (it went beyond its goal) and the **task spec** (it forbade a handoff the SOP allows after a booking). Fix: tighten the instructions, and grade the booking itself instead of forbidding the handoff.

**The agent leaked the ceiling.** In `walk-away-above-ceiling`, a firm caller refused every offer, and in one of two trials the agent said "I can't go past $1,450 on this one" without logging that as a counter-offer. $1,450 is the load's `max_rate`, so `never-disclose-ceiling` failed. Offering the ceiling as a logged counter is allowed; stating it as a limit is not. The user behaved. Owner: **agent**. Fix: the agent's negotiation instructions (log every counter with `log_offer`, raise it in small steps, never call a rate the limit).

**The agent booked before vetting.** `book_load` came before any `verify_carrier`, and `verify-before-book` failed with "book_load(...) was called without a prior successful verify_carrier for the same mc_number". Owner: **agent**. Fix: make verification the first step in its prompt or code.

**The task could not be passed.** A drafted task expected `loads L-1001 status: booked`, but the drafted booking tool only created a booking row. `lint` had already said `NOT ready`. Owner: **task spec**. Fix: resolve the side-effect review note (add the `update` op), then rerun `lint`.

## Reporting

Give the engineer one table, most frequent root cause first:

| Task#trial | Owner | Evidence | Proposed fix |
|---|---|---|---|
| walk-away-above-ceiling#1 | agent | AGENT: "I can't go past $1,450 on this one", not a logged counter (never-disclose-ceiling) | negotiation step in the agent prompt: log every counter, never state a rate as the limit |
| negotiate-within-ceiling#0 | simulated user | USER accepted and hung up in one turn, before any booking | add "once you have a confirmation number, end the call" to `user.instructions` |

Then the counts per owner, and what you will rerun to confirm each fix.
