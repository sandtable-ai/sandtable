# Resolving review items

`sandtable review <domain>` lists pending tools, invariants and tasks. The drafts below are real `init --openapi` output for two fictional APIs: the freight TMS bundled in `examples/freight/source/`, and an invented outdoor-gear shop, Bramble Outfitters. Resolve each note, show the engineer the change, and accept only once they agree.

## Contents
- [Tool notes](#tool-notes): status codes, side effects, action endpoints
- [Drafted invariants](#drafted-invariants)
- [Drafted tasks](#drafted-tasks)
- [Accepting](#accepting)

## Tool notes

### "The API can answer 409/422/400/403 (…): encode that condition as a check with a `where`"

The spec says when the real API refuses a call. Encode the condition so the simulated API refuses it too: otherwise the agent can do in rehearsal what production would block, and a task can pass for the wrong reason.

Draft:

```yaml
tools:
  # TODO(review): The API can answer 409 (Load is not available): encode that condition as a check with a `where`.
  # TODO(review): The description mentions a side effect ("Book a load for a carrier (tenders the load; the load becomes `booked`)"): add ops for any other table it changes.
  - name: create_booking
    description: Book a load for a carrier (tenders the load; the load becomes `booked`)
    params:
      load_id: { type: string }
      mc_number: { type: string }
      rate: { type: number, description: All-in rate in USD }
    checks:
      - { table: loads, key: $load_id, error: "loads ${load_id} not found" }
      - { table: carriers, key: $mc_number, error: "carriers ${mc_number} not found" }
    ops:
      - create: bookings
        values:
          load_id: $load_id
          mc_number: $mc_number
          rate: $rate
    review: pending
```

Resolved (both notes): the existence check on `loads` gains the 409 condition, and the side effect becomes an `update` op.

```yaml
tools:
  - name: create_booking
    description: Book a load for a vetted carrier at the agreed all-in rate in USD. The load becomes booked.
    params:
      load_id: { type: string }
      mc_number: { type: string }
      rate: { type: number, description: All-in rate in USD }
    checks:
      - { table: loads, key: $load_id, where: { status: available }, error: "Load ${load_id} is not available" }
      - { table: carriers, key: $mc_number, error: "carriers ${mc_number} not found" }
    ops:
      - create: bookings
        values: { load_id: $load_id, mc_number: $mc_number, rate: $rate, status: confirmed }
      - update: loads
        key: $load_id
        set: { status: booked }
```

A check can compare a record against an argument. For "422: Amount exceeds the order total" on a refund:

```yaml
tools:
  - name: create_refund
    description: Refund part or all of an order to the original payment method.
    params:
      order_id: { type: string }
      amount: { type: number }
    checks:
      - { table: orders, key: $order_id, where: { total: { $gte: $amount } }, error: "Amount exceeds the order total" }
    ops:
      - create: refunds
        values: { order_id: $order_id, amount: $amount }
```

If a condition depends on something the world does not record (a credit check, a time window), add the field to the seed rows rather than dropping the check, and say so to the engineer.

### "The description mentions a side effect (…): add ops for any other table it changes"

Ops are atomic, so a booking and the load's status change land together or not at all. Leaving the side effect out is the most common reason `lint` says `NOT ready`: tasks expect `loads ... status: booked`, and no tool ever writes it.

### "\"cancel\" is an action on <table>: replace or extend the get op with update/create ops that model its effect"

`POST /orders/{order_id}/cancel` has no resource of its own, so the draft gives it a placeholder `get` that changes nothing:

```yaml
tools:
  # TODO(review): "cancel" is an action on orders: replace or extend the get op with update/create ops that model its effect.
  # TODO(review): The API can answer 409 (Order has already shipped): encode that condition as a check with a `where`.
  - name: cancel_order
    description: Cancel an order that has not shipped yet. The order becomes cancelled.
    params:
      order_id: { type: string }
      reason: { type: string, required: false }
    ops:
      - get: orders
        key: $order_id
    review: pending
```

Resolved:

```yaml
tools:
  - name: cancel_order
    description: Cancel an order that has not shipped yet. The order becomes cancelled.
    params:
      order_id: { type: string }
      reason: { type: string, required: false }
    checks:
      - { table: orders, key: $order_id, where: { status: placed }, error: "Order ${order_id} cannot be cancelled: it has shipped or is already cancelled" }
    ops:
      - update: orders
        key: $order_id
        set: { status: cancelled, cancel_reason: $reason }
```

When an action also creates a record (a return label, a credit note), add a `create` op and set `returns` to the op whose result the real API sends back.

### Warnings with no note

`init` also warns about what it left out: header and cookie params, array and object fields, `DELETE` operations. Add a param, field or tool by hand only when a task needs it, and tell the engineer what the simulation does not model.

## Drafted invariants

Each one quotes the SOP in `source.quote`. For each:

1. **The quote exists.** `init` warns when it is not verbatim. Search the SOP yourself.
2. **It is a hard rule.** "Never", "only", "must", "do not" are hard. "Try to", "prefer", "usually" are not: delete those invariants or ask the engineer.
3. **The kind fits.**
   - `before`: is the right tool first, and are `same` the args that must match (the same carrier, not just any lookup)?
   - `require`: does `where` list every condition in the quote? The SOP drafter sometimes splits one rule into several invariants; that is fine when each is right.
   - `limit`: `lte` means "at most", `gte` "at least". Is the bound the right field of the right record?
   - `match`: are both sides keyed by the right arguments?
   - `never`: does `when` narrow it to exactly the forbidden case? Without `when`, the tool may never be called at all.
   - `never_disclose`: should a legitimately agreed value be allowed through `unless`?
4. **The data supports it.** Every field it reads must be in the seed rows, or the rule silently never fires.

`Soft rule` comments are rules about wording, tone or read-backs that tool calls cannot show. Keep them as notes for the engineer; they are not graded.

## Drafted tasks

Each one quotes the transcript in `source`. For each:

- The expected end state follows the **SOP**. If the human rep booked above the ceiling, the task expects no booking above it.
- `user.instructions` holds a hidden goal with hard limits and a stop condition (see the `writing-good-tasks` skill).
- Names, companies, phone numbers and emails are fictional. Short identifiers such as order or MC numbers may be kept, and must match seed rows.
- The seed rows added for it are plausible and do not change what other tasks expect.
- It is not a near-duplicate of a task you already have.

## Accepting

```yaml
invariants:
  - id: rate-ceiling
    description: Never book above the load's max_rate.
    limit: { tool: create_booking, arg: rate, lte: { table: loads, key_arg: load_id, field: max_rate } }
    review: accepted          # was: pending. Deleting the line also accepts it.
    source: { file: sop.md, quote: "Never book above `max_rate`." }
```

Keep `source` after accepting: it is the trace from the rule back to the customer's words. For tools, delete the `review: pending` line and the `TODO(review)` comments together. Then:

```bash
npx sandtable-ai validate ./sandtable --strict
```
