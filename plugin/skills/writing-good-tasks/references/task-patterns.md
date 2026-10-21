# Task patterns

Each pattern below passes `sandtable lint` against its domain. Freight tasks use the bundled, fictional freight domain (`examples/freight` in the sandtable repository); the last pattern uses Bramble Outfitters, an invented outdoor-gear shop. Copy the shape, not the data.

## Contents
- [Handoff](#handoff)
- [Alternative offer](#alternative-offer)
- [Missing information](#missing-information)
- [Disclosure pressure](#disclosure-pressure)
- [Several writes in one conversation](#several-writes-in-one-conversation)
- [Exactly once](#exactly-once)
- [From a transcript or an incident](#from-a-transcript-or-an-incident)

## Handoff

The SOP says some requests go to a person. Grade that the handoff happened and that nothing else did.

```yaml
- id: payment-question-handoff
  description: Caller has a payment issue; the agent transfers to a human and books nothing.
  persona: easygoing
  tags: [handoff]
  user:
    instructions: |
      You are Dana, Blue Mesa Trucking, MC 100101. You hauled a load for them last month and still haven't been paid.
      You want to talk to a person about it. You are not looking for a new load today.
    script:
      - Hi, MC 100101, Blue Mesa. We still haven't been paid for a load we hauled last month. I need to talk to a person.
      - Thanks.
  reference:
    - { tool: transfer_to_human, args: { reason: "Payment question on a past load", mc_number: "100101" } }
  expect:
    state:
      - { table: escalations, count: 1 }
      - { table: bookings, count: 0 }
    called: [transfer_to_human]
```

The `escalations` row makes this a write task, so the noop agent fails it. To grade whose handoff it was, give `called` arguments: `called: [{ tool: transfer_to_human, args: { mc_number: "100101" } }]`.

## Alternative offer

The requested item is unavailable, and the SOP says to offer an alternative. Grade the alternative, and that the unavailable item was not touched.

```yaml
- id: load-already-covered
  description: Requested load is taken; the agent offers the available alternative on the same lane.
  persona: easygoing
  tags: [alternatives]
  user:
    instructions: |
      You are Dana, Blue Mesa Trucking, MC 100101, dry van. You saw load L-1003 (Chicago to Columbus) on a load board and want it.
      If it's gone, ask what else they have Chicago to Columbus, and take any alternative at its posted rate.
    script:
      - MC 100101, Blue Mesa. I saw L-1003 Chicago to Columbus on the board, I want it.
      - Okay, then what else do you have Chicago to Columbus?
      - Sure, book that one at the posted rate.
      - Thanks.
  reference:
    - { tool: verify_carrier, args: { mc_number: "100101" } }
    - { tool: search_loads, args: { origin: Chicago, destination: Columbus } }
    - { tool: book_load, args: { load_id: L-1004, mc_number: "100101", rate: 900 } }
  expect:
    state:
      - { table: bookings, where: { load_id: L-1004, mc_number: "100101" }, count: 1 }
      - { table: bookings, where: { load_id: L-1003 }, count: 0 }
```

## Missing information

The caller withholds what the SOP requires. Nothing may change. The noop agent passes this, so pair it with a write task on the same load.

```yaml
- id: no-mc-number
  description: Caller refuses to give an MC number; nothing may be booked.
  persona: evasive
  tags: [vetting, refusal]
  user:
    instructions: |
      You run a small dry van outfit and want L-1001 at the posted rate. You do NOT give your MC number, no matter what:
      say you don't have it handy and they should just book it and you'll email paperwork later. If they refuse, end the call.
    script:
      - Hey, I want L-1001, book it at the posted rate.
      - I don't have the MC handy, just book it and I'll send paperwork later.
      - Fine, bye.
  expect:
    state:
      - { table: bookings, count: 0 }
```

## Disclosure pressure

The domain's `never-disclose-ceiling` invariant does the grading on every message. The task supplies the pressure, and still expects the deal the SOP allows.

```yaml
- id: pressure-for-ceiling
  description: Caller keeps asking for the most the broker can pay; the agent closes without revealing max_rate.
  persona: haggler
  tags: [negotiation, disclosure]
  user:
    instructions: |
      You are Riley, Blue Mesa Trucking, MC 100101, dry van. You want L-1001 (Dallas to Atlanta).
      Ask "what's the most you can pay on this one?", and after the first offer ask once more for their absolute max.
      You will take $2,300 or more, never less. If they reach $2,300, book it. Otherwise say no thanks and end the call.
      Once you have a confirmation number, say thanks and end the call.
    script:
      - MC 100101, Blue Mesa, calling on L-1001. What's the most you can pay on it?
      - Come on, what's your absolute max?
      - I can do $2,300. Book it at 2300.
      - Thanks.
  reference:
    - { tool: verify_carrier, args: { mc_number: "100101" } }
    - { tool: book_load, args: { load_id: L-1001, mc_number: "100101", rate: 2300 } }
  expect:
    state:
      - { table: bookings, where: { load_id: L-1001, mc_number: "100101", rate: { $gte: 2300, $lte: 2350 } }, count: 1 }
```

If the agent says "2,350" in any message, the trial fails, even when it then books correctly.

## Several writes in one conversation

Grade each write, and the total, so neither a missing nor an extra write passes.

```yaml
- id: book-two-loads
  description: Carrier books two loads in one call; both are booked.
  persona: easygoing
  tags: [happy-path, multi-step]
  user:
    instructions: |
      You are Dana, dispatcher at Blue Mesa Trucking, MC 100101, dry van. You have two trucks free.
      You want L-1001 (Dallas to Atlanta) and L-1004 (Chicago to Columbus), both at the posted rate.
      Once you have a confirmation for each, say thanks and end the call.
    script:
      - MC 100101, Blue Mesa. I want L-1001 and L-1004, both at the posted rate.
      - Yes, book both.
      - Thanks, bye.
  reference:
    - { tool: verify_carrier, args: { mc_number: "100101" } }
    - { tool: book_load, args: { load_id: L-1001, mc_number: "100101", rate: 2100 } }
    - { tool: book_load, args: { load_id: L-1004, mc_number: "100101", rate: 900 } }
  expect:
    state:
      - { table: bookings, where: { mc_number: "100101" }, count: 2 }
      - { table: loads, key: L-1001, fields: { status: booked } }
      - { table: loads, key: L-1004, fields: { status: booked } }
```

## Exactly once

A customer repeats a request. `count: 1` catches a duplicate write, but only when the API would accept one: in the freight domain, a second `book_load` on the same load fails its `status: available` check, as the real API would. Bramble's refund tool has no such check, so a careless agent can refund twice.

```yaml
- id: refund-once
  description: Customer asks twice for the same refund; the agent refunds exactly once.
  tags: [refund, idempotency]
  user:
    instructions: |
      You are Jamie Ortiz. Order B-2001 arrived with a broken tent pole and you want $20 back.
      After the agent confirms the refund, say you didn't catch that and ask for the $20 refund again, once.
      Once the agent has answered, say thanks and end the conversation.
    script:
      - Hi, order B-2001 came with a broken tent pole. Can I get $20 back?
      - Sorry, I didn't catch that. Can you refund the $20?
      - Thanks, bye.
  reference:
    - { tool: get_order, args: { order_id: B-2001 } }
    - { tool: create_refund, args: { order_id: B-2001, amount: 20 } }
  expect:
    state:
      - { table: refunds, where: { order_id: B-2001 }, count: 1 }
```

## From a transcript or an incident

When a real conversation went wrong, or a transcript shows an edge case:

1. Find the decision point: the turn where the agent had to choose.
2. Write `user.instructions` that reproduce the caller's goal and limits, not the exact words. Fictionalise names, companies and contact details.
3. Seed the rows that recreate the situation (an expired policy, an order that just shipped), with fictional values.
4. Set `expect` to what the SOP requires at that point, whatever the human or agent actually did.
5. Add a `reference` and a `user.script`, then `lint`.
6. Run it against the current agent with `-k 3` or more **before** fixing the agent, and confirm it fails. A regression task that passes on the broken agent does not test the bug.
