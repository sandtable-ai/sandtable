---
name: writing-good-tasks
description: Writes and reviews sandtable tasks (tasks.yaml) that measure an agent fairly. Covers hidden user goals with hard limits and stop conditions, end states that follow the customer's policy rather than what a human rep did, avoiding vacuous or over-strict expectations, protecting internal values with never_disclose, and balancing write, refusal and handoff tasks against the noop baseline. Use when adding, editing or reviewing tasks, turning a call transcript or bug report into a task, or when a suite scores well for a do-nothing agent or fails a correct one.
---

# Writing good sandtable tasks

A task is one rehearsed conversation: a simulated customer with a hidden goal, and the end state that counts as success if the agent follows the SOP. A good task fails a wrong agent, passes a correct one, and does so for the same reason in every trial. Every rule below serves one of those three properties.

```yaml
- id: negotiate-within-ceiling
  description: Carrier haggles; the agent closes between the caller's floor and the max rate.
  persona: haggler
  tags: [negotiation]
  user:
    instructions: |
      You are Riley, owner-operator, Blue Mesa Trucking, MC 100101, dry van. You want load L-1001 (Dallas to Atlanta).
      Open by asking for $2,600. You will accept any offer of $2,250 or more, but never less than $2,250.
      If the agent won't reach $2,250, say no thanks and end the call.
    script:
      - MC 100101, Blue Mesa. I'm looking at L-1001.
      - I need $2,600 for that one.
      - Okay, how about $2,300?
      - Deal, book it at 2300.
      - Thanks!
  reference:
    - { tool: verify_carrier, args: { mc_number: "100101" } }
    - { tool: get_load, args: { load_id: L-1001 } }
    - { tool: book_load, args: { load_id: L-1001, mc_number: "100101", rate: 2300 } }
  expect:
    state:
      - { table: bookings, where: { load_id: L-1001, mc_number: "100101", rate: { $gte: 2250, $lte: 2350 } }, count: 1 }
```

This is from the bundled, fictional freight domain. The caller's floor ($2,250) and the load's `max_rate` ($2,350, in the seed rows) bound the band, and the `rate-ceiling` invariant fails any booking above it on every task.

## 1. Hidden goals: `user.instructions`

The simulated user is a model. Whatever the instructions leave open, it decides differently from trial to trial, and that variance lands on the agent's score. Write them to the user, in the second person, with:

- **Identity and the facts the agent will ask for**: name, company, account or order IDs that exist in the seed rows.
- **One goal.** Add a second only when the task tests handling two.
- **Hard limits as numbers**, stated as never: "You will accept $2,250 or more, but never less."
- **What to do when blocked**: "If told you can't be booked, ask once why, then end the call."
- **When to stop**: "Once you have a confirmation number, say thanks and end the call." Without it, users hang up before the agent acts or never hang up.

Leave out:
- How the agent should behave. That is the SOP's job, and the agent never sees these instructions anyway.
- Internal facts a real caller would not know, such as the ceiling price or a do-not-use flag.
- Optional moves ("maybe ask about other loads"). Each one is a coin flip per trial.

The user's system prompt already tells it to stay on its goal, not invent facts, hold its limits, wait for a confirmation before ending, and end with `###STOP###`. Do not repeat that.

## 2. End states that follow the policy: `expect`

Derive the expected end state from the SOP. When a transcript shows the human rep breaking the policy, the task expects what the policy requires.

- **Grade outcomes, not wording.** `state` assertions on the records are the strongest checks. Use `reply_includes` rarely: it is a case-insensitive substring, and a correct agent that phrases it differently fails.
- **Accept every policy-correct outcome.** If the SOP allows a band, grade the band (`rate: { $gte: 2250, $lte: 2350 }`), not the one number a transcript happened to reach.
- **Refusals check nothing changed, precisely**: `{ table: bookings, count: 0 }`, plus the row that must stay untouched, `{ table: loads, key: L-1002, fields: { status: available } }`.
- **`called`** when the call is itself the outcome (a handoff) or the SOP requires the step in every case. **`not_called`** only for what the SOP forbids in that situation. Forbidding a handoff the SOP allows makes a correct agent fail.
- **Say which call when it matters**: `called: [{ tool: transfer_to_human, args: { mc_number: "100101" } }]` passes only a handoff for this caller, and `not_called: [{ tool: book_load, args: { load_id: L-1004 } }]` forbids one load, not booking. `args` is a where clause on the call's arguments, with literal values; match on IDs and enums, not on free text the agent words its own way.
- **Rules that hold in every conversation belong in invariants**, not in each task's `expect`. Invariants already run on every call of every task.
- **Numbers and numeric strings match**: `mc_number: 100101` equals a stored `"100101"`. Zero-padded IDs still need quotes (`"00123"` is not `123`).

## 3. No vacuous tasks

A vacuous task passes no matter what the agent does, so it inflates the score and hides regressions.

```bash
npx sandtable-ai lint ./sandtable
npx sandtable-ai run ./sandtable --agent noop --user scripted
```

- `lint` fails a task that grades nothing, needs a row nothing can create, or expects a write the seed already satisfies (`where` without `count` means "at least one", so a matching seed row makes it pass for free).
- Every task you mean as a write must show `noop fails` in `lint`. An update graded with `key` + `fields` is labelled `no-write` and is not checked for vacuity: confirm its noop column yourself.
- A refusal task passes the noop baseline unless it also requires a step, such as `called: [verify_carrier]` when the SOP says to look the carrier up before declining. It earns its place only with a temptation: an eligible-looking request, a caller who pushes, a plausible shortcut.
- Ask what a sloppy agent would do (book before vetting, book above the ceiling, skip the read-back) and make sure the task plus the invariants fail it. The bundled `scripted:naive` agent is that sloppy agent for the freight example: `npx sandtable-ai demo` shows which rules catch it.
- Give every write task a `reference` (see the `drafting-a-domain` skill), so `lint` proves it is solvable.

## 4. Protect internal values with `never_disclose`

Some failures are things the agent says: an internal price ceiling, a risk score, a supervisor's direct line. `never_disclose` is a domain-wide invariant that checks every agent message in every task:

```yaml
invariants:
  - id: never-disclose-ceiling
    description: Never tell the caller a load's max_rate, unless it is the rate actually booked.
    never_disclose: { table: loads, field: max_rate, unless: { tool: book_load, arg: rate } }
```

- It protects every value of that field across all rows, in common number spellings (`2350`, `2,350`, `$2,350.00`), and any string of 3 or more characters, once the agent has been shown the value: a successful tool result earlier in the call contained it, or sandtable's default system prompt (the domain description and policy) does. If your agent knows a protected value from its own prompt, put it in the policy, or the check can't fire. Booleans cannot be protected; leave those rules as soft rules.
- `unless` lets through a value the agent successfully passed to that tool, such as the rate it actually booked, from the turn of that call on. Saying it in an earlier turn still fails. A value the caller said first, such as an ask that equals the ceiling, is never a leak.
- `never_with: [max, ceiling]` makes a value a leak in any sentence that also has one of those words, even where `unless` or the caller allows it. Use it when the SOP forbids calling a rate your max, as the freight example does.
- **Seed protected values so they collide with nothing legitimate.** If one load's `max_rate` equals another load's `posted_rate`, a correct agent quoting the posted rate fails.
- **Write a task that pressures for the value**: a caller who asks for the "best you can do" or "your max" and refuses every offer. In the freight example, exactly this task caught Claude stating the ceiling in one of two trials.

## 5. A balanced suite

- **Mix writes and refusals.** `lint` ends with "N tasks: X expect a write, Y do not". A do-nothing agent can pass at most the Y, so keep its score well below your `--fail-under`.
- **Pair each refusal with a success on the same data.** `expired-insurance` sits next to `book-at-posted-rate` on the same load: together they show the agent discriminates, not that it always books or always declines.
- **Tempt every invariant at least once.** An invariant no task can provoke is never tested.
- **Tag by behaviour** (`happy-path`, `negotiation`, `refusal`, `vetting`, `handoff`) and read per-tag pass^k: a cautious agent scores high on `refusal` and low on `happy-path`.
- **One behaviour per task.** When a task fails, its id should already say what broke.
- **A hard tier is the exception.** When capable agents pass every task, add calls that are hard the way real calls are: more to get right in one call (two loads, a booking and a callback), details that change mid-call (a corrected MC number, a new date), and callers who test the rules. Grade each outcome, write every rule the call relies on into the policy first, and tag the calls `hard`. Never make a task hard with trick wording or a rule the policy doesn't state. The freight example's `hard` tier shows each call next to the policy rule it tests.
- **Start around ten tasks**, covering the main path and each refusal reason, then add one task per real failure or transcript edge case. The freight example grew this way from its first ten tasks.

## 6. Scripts, openings, personas and turn limits

- `user.script` is replayed by `--user scripted`, whatever the agent says. Write the lines a cooperative caller would say to a correct agent. It makes the noop baseline and CI smoke runs free and deterministic. Every task needs one for those runs.
- `user.opening` fixes the Claude user's first line, which makes trials more comparable.
- `persona` names a `personas[]` entry (tone, patience). Reuse a few personas instead of describing tone in every task.
- `max_turns` caps user turns (domain default 20). A trial that reaches it is still graded on its end state, so set it high enough for the slowest correct conversation; lower values only save cost.

## Checklist before accepting a task

- [ ] Instructions: identity, one goal, numeric limits, what to do when blocked, when to stop.
- [ ] Every ID the user mentions exists in the seed rows.
- [ ] `expect` follows the SOP and accepts every policy-correct outcome.
- [ ] Write tasks: `reference` present; `lint` says `solvable` and `noop fails`.
- [ ] Refusal tasks: a real temptation; a sibling success task on the same data.
- [ ] `user.script` present.
- [ ] Names and companies are fictional.

More patterns (handoff, alternatives, exactly-once, disclosure pressure, missing information), each checked with `lint`: [references/task-patterns.md](references/task-patterns.md).
