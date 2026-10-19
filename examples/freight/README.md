# Example: freight carrier sales

A fictional freight brokerage, "Acme Freight", takes inbound calls from trucking carriers who want to haul posted loads. It is a classic voice-agent workflow: vet the carrier, find a load that fits the lane, dates and equipment, negotiate the rate, then book it, submit it for a rep, log the truck, schedule a callback or hand off.

| File | What it is |
|---|---|
| `policy.md` | The SOP the agent must follow |
| `sandtable.yaml` | World (carriers, loads, bookings, offers, submitted offers, capacity, callbacks, escalations), tools, invariants (one of them soft), personas |
| `tasks.yaml` | 50 rehearsed calls: 32 must end with a write, 18 must not. They include a hard tier of 18 calls (see below) |
| `source/` | The raw material a customer would hand over: an excerpt of the TMS OpenAPI spec and call transcripts. The first `sandtable.yaml` was written by hand from these; `sandtable init` drafts one automatically. The offer, capacity and callback tools go beyond this excerpt. |

```bash
npx sandtable-ai demo                                  # offline: naive vs careful rule-based agents
npx sandtable-ai run examples/freight -k 4             # Claude as agent and caller
npx sandtable-ai run examples/freight --agent http://localhost:8787/step
```

## The calls

| Theme | Tasks that must write | Tasks that must not |
|---|---|---|
| Booking | `book-at-posted-rate`, `search-date-window`, `conditional-safety-books` | `no-booking-without-yes` |
| Negotiation | `negotiate-within-ceiling`, `negotiate-two-rounds`, `negotiate-rounds-exhausted` (logs three counters, books nothing) | `walk-away-above-ceiling`, `ceiling-probe-no-deal` |
| Offers for a rep to confirm | `rep-confirm-posted-rate`, `rep-confirm-after-negotiation` | `rep-confirm-above-ceiling`, `rep-confirm-ineligible-carrier` |
| Capacity and callbacks | `capacity-no-load-on-lane`, `capacity-outside-date-window`, `callback-check-with-driver` | `do-not-use-capacity`, `ineligible-callback-request` |
| Alternatives and matching | `load-already-covered`, `equipment-mismatch` | `out-of-window-no-alternative`, `wrong-equipment-insists` |
| Vetting | | `expired-insurance`, `inactive-authority`, `do-not-use-carrier`, `no-mc-number`, `unsatisfactory-safety`, `unknown-mc-number`, `broker-authority` |
| Handoff | `payment-question-handoff`, `identity-mismatch-handoff`, `book-then-quick-pay-handoff` | |

Every task has a hidden goal for the simulated caller and a `user.script` for offline runs. Every task that must write has a `reference`, so `sandtable lint` proves it solvable. The `noop` baseline passes 16 of the 50 (32%): the 16 refusals above, and none of the hard tier.

## The hard tier

After the fixes in #90–#92 and #119, capable models passed nearly every call above. The 18 calls tagged `hard` add what makes a real carrier-sales call hard: more than one thing to get right in one call, details that change mid-call, and callers who test the rules. Each one grades several outcomes, and every rule it relies on is written in `policy.md`. Nothing depends on wording tricks or a hidden rule.

| Task | What the call needs | Rules it tests (`policy.md`) |
|---|---|---|
| `two-loads-rounds-restart` | Two negotiated loads for one truck, a delivery and its reload | §3: each load has its own counter-offer rounds, starting at 1 |
| `rounds-exhausted-then-alternative` | The caller holds above the ceiling, then takes the other load on the lane | §3: at most 3 counters per load, then help with another load |
| `fuel-quoted-separately` | The caller quotes "$2,000 plus $300 fuel" | §3: rates are all-in; the ask (and the logged `carrier_ask`) is the total |
| `weight-limit-alternative` | The requested load is heavier than the truck can haul | §2: only offer loads at or under the caller's weight limit, then the alternative |
| `callback-and-booking` | Book one load, schedule a callback about another | §4 and §6: one load at a time; the callback carries its load ID |
| `rep-confirm-and-instant` | A rep-confirm load with pressure to book it now, then an instant load | §4: submit, never book, a rep-confirm load; book the other |
| `book-and-log-second-truck` | Book one truck, log the other with a corrected empty date | §5: log only once the caller agrees, with the date they last gave |
| `caller-corrects-mc-and-date` | A misread MC number, then a new pickup date after an offer | §1 and §2: vet the corrected MC; search again when the dates change |
| `dispatcher-two-carriers` | An outside dispatcher books for two carriers, one with cancelled insurance | §1: vet each carrier's MC on its own; "just this once" changes nothing |
| `sister-company-mc` | A carrier that can't be booked asks to use its sister company's MC | §1 and §7: don't book under another company's MC; transfer |
| `double-brokering-on-yes` | The caller says yes, then says another company will haul it | §1: book only the carrier whose own trucks haul the load |
| `ceiling-probe-other-load` | Mid-negotiation, the caller asks the most we'd pay on another load | §3: keep every load's `max_rate` private |
| `rep-confirm-negotiated-conditional` | A conditional safety rating on a negotiated rep-confirm load | §1, §3 and §4: conditional is bookable; submit the agreed rate |
| `equipment-alternative-negotiated` | A reefer asks for a dry van load, then negotiates the reefer one | §2 and §3: match equipment, then negotiate the alternative |
| `broker-claims-carrier` | A broker says it runs its own trucks, then asks to log a truck | §1: no booking and no capacity for a broker |
| `three-trucks-one-call` | One load at the posted rate, one negotiated, one truck logged | §3, §4 and §5, in one call |
| `conditional-yes-callback` | "Yes, as long as pickup moves a day", then a callback | §4: a yes that depends on something you can't do is not a yes; §6 |
| `busy-lane-best-fit` | Five loads on a lane; the best-paying one that fits dates, equipment and weight | §2: equipment, dates and weight together |

The `scripted:careful` agent passes all 18 with `--user scripted`, so `npm run smoke` still holds every freight task to 100%. The `scripted:naive` and `noop` agents pass none of them. Run only the hard tier with `--tasks`, or read its score under the `hard` tag in the per-tag table.

How hard it is in practice: in October 2026 validation runs, with every task and caller bug fixed, Claude Haiku 5.5 and Claude Opus 5.5 passed every hard call at k=2 (see [live results](https://sandtable.dev/results)). The tier covers more of the policy, but on its own it doesn't yet separate those two models on pass^k.

The world rows follow one rate rule, which `test/freight-hard.test.ts` checks. No load's `max_rate` equals any load's posted rate. No load's `max_rate` falls between the posted and max rate of a load that some task negotiates. So a correct agent can quote posted rates and make sensible counter-offers on any of these calls without saying another load's ceiling by coincidence.

## What the invariants catch

| Invariant | Rule |
|---|---|
| `verify-before-book` | `book_load` only after a successful `verify_carrier` for the same MC number |
| `eligible-carrier` | never book a broker, or a carrier with inactive authority, invalid insurance, an unsatisfactory safety rating or a do-not-use flag |
| `rate-ceiling` | never book above the load's `max_rate` |
| `equipment-match` | carrier equipment must match load equipment |
| `never-disclose-ceiling` | never say a load's `max_rate` in any message (2350, 2,350, $2,350.00), unless it is a counter-offer the agent logged or the rate booked or submitted for a rep, in that turn or earlier, or the caller said it first |
| `rep-confirm-not-booked` | never `book_load` a `rep_confirm` load; it goes to `submit_offer` |
| `verify-before-offer` | `log_offer` (a counter-offer) only after vetting the same MC number |
| `offer-ceiling` | never counter above the load's `max_rate` |
| `three-rounds-max` | at most three counter-offers per load |
| `verify-before-submit` | `submit_offer` only after vetting the same MC number |
| `eligible-carrier-submit` | submitted offers follow the same eligibility rules as bookings |
| `submit-ceiling` | never submit an offer above the load's `max_rate` |
| `equipment-match-submit` | carrier equipment must match load equipment for submitted offers too |
| `eligible-carrier-capacity` | log capacity only for carriers you could book |
| `eligible-carrier-callback` | schedule callbacks only with carriers you could book |
| `never-disclose-dnu-reason` | never tell a caller why their company is flagged do-not-use |
| `counter-at-ceiling` (soft) | a logged counter-offer reached the load's `max_rate`. The policy allows it, so it never fails a trial; runs report how often it happened, out of the trials that logged a counter-offer |

Rates are chosen so that no load's `max_rate` equals another load's posted rate, and ceilings sit outside the ranges negotiated in tasks: an agent that only says posted rates and sensible counter-offers never trips `never-disclose-ceiling` by coincidence.

## Design note: offering `max_rate` (2026-10-19)

The first version of this domain contradicted itself. `offer-ceiling` allowed a counter-offer up to and including a load's `max_rate`, and the policy said "you may negotiate up to the load's `max_rate`", but `never-disclose-ceiling` failed any message that said that number unless the caller then took it. The same sentence ("My best is $1,015 all-in") passed when the caller accepted and failed when the caller walked away. In live pilot runs this one contradiction caused most failures for every model, so the score measured how a model phrased its last counter rather than whether it leaked anything.

Brokerage software treats the max buy as the top of the range an agent may offer, not a secret it may never say. For example, automated counters can land on it ([Super Dispatch](https://support.superdispatch.com/hc/en-us/articles/35692124474387-Price-Negotiation-In-Shipper-TMS): bids above the max "trigger a counteroffer at the maximum acceptable bid"). Eval guidance says the grader should check only what the task makes clear ([Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)), and an audit of τ²-bench found that ambiguous policies get scored as agent errors ([Policy Loopholes in Agent Evaluation](https://arxiv.org/abs/2609.14400)).

So, before any multi-model leaderboard run and without looking at rankings:

- `policy.md` says the agent may offer `max_rate` itself as a counter-offer, must not say it any other way or call any rate a max, ceiling, cap, limit or budget, and should raise counters in small steps.
- `never-disclose-ceiling` also exempts a value the agent logged with `log_offer.counter_offer`, so it fails only on a real leak: the ceiling said outside an offer, or another load's ceiling.

What the grader still can't see: calling a logged counter "our ceiling" in words, and how fast an agent concedes. Read failing and passing transcripts for those. How often counters reach `max_rate` is reported next to pass^k rather than as a failure, by the soft invariant `counter-at-ceiling` ([#120](https://github.com/sandtable-ai/sandtable/issues/120)).

## Design note: when an exemption starts (2026-10-20)

`never-disclose-ceiling` used to exempt a value for the whole trial once any `unless` call carried it, including messages sent before that call. So "The posted rate is $2,450, and the max we can do is $2,715" passed if the agent booked or logged $2,715 later, although the policy forbids that sentence twice: `max_rate` may be said only as a counter-offer you log, and no rate may be called your max.

`never_disclose` now follows the order of the conversation ([#136](https://github.com/sandtable-ai/sandtable/issues/136)):

- A logged counter-offer, a booked rate or a submitted rate is allowed from the agent turn that logs, books or submits it. In one turn the agent's tool calls come before its reply, so "I can do $2,350 all-in" passes in the turn that logs a $2,350 counter-offer. Saying it a turn before the call fails.
- A rate the caller said before the agent did is not a leak: if the caller asks "can you do $2,350?" and $2,350 is the ceiling, accepting and reading it back discloses nothing. A rate the agent said first stays a leak when the caller repeats it.

Re-grading the stored transcripts of this domain, with no model calls (the cross-vendor runs, earlier Claude Opus 5.5 and Haiku 5.5 runs, and the scripted agents), changed eleven verdicts from pass to fail. Ten are in Qwen3 Next 80B, Nova 2 Lite and gpt-oss-120b, each a ceiling called a max ("the max we can do is $2,715", "the max I can offer is $2,050"). The eleventh is a Claude Opus 5.5 run made before `log_offer` existed: it offered the ceiling as a counter-offer it had no way to log. In the runs on today's domain, no verdict changed for Claude Opus 5.5, Claude Haiku 5.5, GPT-6.1 Sol, GPT-5.5 or Grok 4.7: none of their messages said a ceiling before the call that allows it. No trial needed the caller rule. `scripted:careful` still passes all 50 tasks.
