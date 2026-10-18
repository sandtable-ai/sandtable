# Example: freight carrier sales

A fictional freight brokerage, "Acme Freight", takes inbound calls from trucking carriers who want to haul posted loads. It is a classic voice-agent workflow: vet the carrier, find a matching load, negotiate the rate, book it or hand off.

| File | What it is |
|---|---|
| `policy.md` | The SOP the agent must follow |
| `rehearsal.yaml` | World (carriers, loads, bookings, escalations), tools, invariants, personas |
| `tasks.yaml` | 10 rehearsed calls: happy path, negotiation, vetting refusals, alternatives, equipment mismatch, handoff |
| `source/` | The raw material a customer would hand over: TMS OpenAPI spec and call transcripts. `rehearsal.yaml` was written by hand from these; `rehearse init` will draft it automatically. |

```bash
npx rehearse-agents demo                                  # offline: naive vs careful rule-based agents
npx rehearse-agents run examples/freight -k 4             # Claude as agent and caller
npx rehearse-agents run examples/freight --agent http://localhost:8787/step
```

What the invariants catch:

| Invariant | Rule |
|---|---|
| `verify-before-book` | `book_load` only after a successful `verify_carrier` for the same MC number |
| `eligible-carrier` | never book a carrier with inactive authority, expired insurance, an unsatisfactory safety rating or a do-not-use flag |
| `rate-ceiling` | never book above the load's `max_rate` |
| `equipment-match` | carrier equipment must match load equipment |
