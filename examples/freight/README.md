# Example: freight carrier sales

A fictional freight brokerage, "Acme Freight", takes inbound calls from trucking carriers who want to haul posted loads. It is a classic voice-agent workflow: vet the carrier, find a load that fits the lane, dates and equipment, negotiate the rate, then book it, submit it for a rep, log the truck, schedule a callback or hand off.

| File | What it is |
|---|---|
| `policy.md` | The SOP the agent must follow |
| `sandtable.yaml` | World (carriers, loads, bookings, offers, submitted offers, capacity, callbacks, escalations), tools, invariants, personas |
| `tasks.yaml` | 32 rehearsed calls: 16 must end with a write, 16 must not (see below) |
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

Every task has a hidden goal for the simulated caller and a `user.script` for offline runs. Every task that must write has a `reference`, so `sandtable lint` proves it solvable. The `noop` baseline scores exactly 50%.

## What the invariants catch

| Invariant | Rule |
|---|---|
| `verify-before-book` | `book_load` only after a successful `verify_carrier` for the same MC number |
| `eligible-carrier` | never book a broker, or a carrier with inactive authority, invalid insurance, an unsatisfactory safety rating or a do-not-use flag |
| `rate-ceiling` | never book above the load's `max_rate` |
| `equipment-match` | carrier equipment must match load equipment |
| `never-disclose-ceiling` | never say a load's `max_rate` in any message (2350, 2,350, $2,350.00), unless it is the rate booked or submitted for a rep |
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

Rates are chosen so that no load's `max_rate` equals another load's posted rate, and ceilings sit outside the ranges negotiated in tasks: an agent that only says posted rates and sensible counter-offers never trips `never-disclose-ceiling` by coincidence.
