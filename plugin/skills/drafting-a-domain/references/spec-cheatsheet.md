# Domain spec cheat sheet

A condensed, checked copy of `docs/reference/spec.mdx` in the sandtable repository, with the gotchas that cost time. Examples use the bundled, fictional freight carrier-sales domain.

## Contents
- [Top level](#top-level)
- [Templates and where clauses](#templates-and-where-clauses)
- [Tools](#tools)
- [Invariants](#invariants)
- [Tasks and expectations](#tasks-and-expectations)
- [Gotchas](#gotchas)

## Top level

```yaml
name: freight-carrier-sales        # required
description: Acme Freight, a (fictional) freight brokerage. You answer inbound calls from carriers.
policy: ./policy.md                 # the SOP; the reference Claude agent uses it as its system prompt
max_turns: 16                       # user turns per trial (default 20); tasks can override
world: { tables: {} }
tools: []
invariants: []
personas: []
tasks: ./tasks.yaml                 # any top-level value that is a relative .md/.yaml/.yml path is inlined
```

`description` is shown to both the agent and the simulated user.

## Templates and where clauses

- `"$arg"` becomes the call's argument value, keeping its type. `"${arg}"` interpolates inside a longer string.
- An argument's name is a letter or `_`, then letters, digits or `_`. Other strings stay literal, even with a leading `$` (`"$5"`, `"$/hr"`, `"$@type"`), but a whole `"$USD"` is a reference.
- `validate` fails when a tool's `ops` or `checks` refer to a param the tool doesn't have.
- A condition whose argument was not passed (an optional param) is dropped, so it filters nothing.
- A plain value in `where`, `fields`, `when` or a `called`/`not_called` entry's `args` means equality. An object of operators means all must hold:

| Operator | Meaning |
|---|---|
| `$eq`, `$ne` | equal, not equal |
| `$in`, `$nin` | in, not in a list |
| `$gt`, `$gte`, `$lt`, `$lte` | numeric comparison (strings compare lexically, so ISO dates work) |
| `$exists` | `true`: the field is set and not null |
| `$contains` | case-insensitive substring |

## Tools

```yaml
tools:
  - name: book_load                    # ^[a-zA-Z0-9_-]{1,64}$, the name the agent calls
    description: Book a load for a vetted carrier at the agreed all-in rate in USD. Only call after the caller has explicitly agreed.
    params:
      load_id: { type: string }        # string | number | integer | boolean; required by default
      mc_number: { type: string }
      rate: { type: number, description: "Agreed all-in rate in USD" }
      note: { type: string, required: false }
    checks:                            # what the real API enforces (404, 409, 422): failing one is a tool error, no writes
      - { table: loads, key: $load_id, where: { status: available }, error: "Load ${load_id} is not available" }
    ops:                               # run in order, atomically
      - create: bookings
        values: { load_id: $load_id, mc_number: $mc_number, rate: $rate, status: confirmed }
      - update: loads
        key: $load_id
        set: { status: booked }
    returns: 0                         # which op's result the agent sees (default 0)
```

| Op | Effect | Returns |
|---|---|---|
| `get: <table>`, `key` | read one row; error if missing | the row |
| `list: <table>`, `where?`, `limit?` | filter rows | array of rows |
| `create: <table>`, `values` | insert a row | the new row |
| `update: <table>`, `key`, `set` | merge fields into a row; error if missing | the updated row |
| `respond: <value>` | no state change | the value (templated) |

- Params also take `enum` and `default` (used when the agent omits an optional param).
- A check's `where` can compare against an argument: `where: { total: { $gte: $amount } }` rejects a refund larger than the order total.
- A check is skipped when its `key` comes from an optional argument the agent did not pass.
- Arguments are validated first: unknown names, missing required ones and wrong types return a tool error. Representations are coerced: `"2,100"` becomes `2100` for a number, `100101` becomes `"100101"` for a string.

## Invariants

Checked before every tool call, against the world at that moment. Attempting a forbidden action is a violation even if the call then fails a check. `never_disclose` is checked on every agent message instead. Every invariant needs `id` and `description`. Drafted ones also carry `review` and `source`.

```yaml
invariants:
  - id: verify-before-book            # `then` only after a successful `first` with equal `same` args
    description: A carrier must be looked up with verify_carrier before it is booked.
    before: { first: verify_carrier, then: book_load, same: [mc_number] }

  - id: eligible-carrier               # the record keyed by an argument must exist and match `where`
    description: Only book carriers with valid insurance and no do-not-use flag.
    require: { tool: book_load, table: carriers, key_arg: mc_number, where: { insurance_status: valid, do_not_use: false } }

  - id: rate-ceiling                   # numeric bound: a constant or another record's field (lte, gte; strict lt, gt)
    description: Never book above the load's max_rate.
    limit: { tool: book_load, arg: rate, lte: { table: loads, key_arg: load_id, field: max_rate } }

  - id: equipment-match                # two referenced records must agree on a field
    description: The carrier's equipment must match the load's equipment.
    match:
      tool: book_load
      left: { table: carriers, key_arg: mc_number, field: equipment }
      right: { table: loads, key_arg: load_id, field: equipment }

  - id: no-large-refunds               # never call a tool, optionally only with matching args
    description: Refunds above $500 need a supervisor.
    never: { tool: issue_refund, when: { amount: { $gt: 500 } } }

  - id: never-disclose-ceiling         # no agent message may contain a value of table.field it hasn't been allowed yet
    description: Never tell the caller a load's max_rate, unless it is the rate actually booked.
    never_disclose: { table: loads, field: max_rate, unless: { tool: book_load, arg: rate }, never_with: [max, ceiling] }
    review: pending
    source: { file: sop.md, quote: "Never tell the caller the max_rate or that a ceiling exists." }

  - id: counter-at-ceiling             # soft: reported as a rate, never fails a trial
    description: A counter-offer reached the load's max_rate (allowed, but worth measuring).
    soft: true
    limit: { tool: log_offer, arg: counter_offer, lt: { table: loads, key_arg: load_id, field: max_rate } }
```

`never_disclose` matches numbers in common spellings (`2350`, `2,350`, `$2,350.00`) and strings of 3 or more characters, across every row of the table, once the agent has been shown the value: a successful tool result earlier in the conversation contained it (in any field), or it is in sandtable's default system prompt (the domain description and policy). A value the agent never saw only matches by coincidence, so it doesn't count. If your agent knows a protected value from its own prompt, put it in the policy, or this check can't fire. `validate` warns (`⚠`) when no tool returns the protected table and the policy states none of its values. `unless` allows a value the agent passed successfully to that tool, from the agent turn of that call on (a message in an earlier turn still fails); a list (`unless: [{ tool: book_load, arg: rate }, { tool: submit_offer, arg: rate }]`) allows several. A value the caller said before the agent did is never a leak when the agent repeats it. `never_with` lists words (whole words, any case) that make the value a leak in any sentence that has both, even where `unless` or the caller allows it: use the words the SOP forbids, such as "never call a rate your max or ceiling". Whole words means `limit` doesn't match `limits` or `limited`, so list each form. A word in another sense ("weight limit") or a negation ("I can't share our ceiling, but I can do $2,350") in the same sentence also fails: read every `next to "<word>"` violation. Booleans cannot be protected: `validate` rejects a `never_disclose` whose seeded values are booleans or all shorter than 3 characters, and `init --sop` drops such a draft with a warning.

`soft: true` works on every kind. A soft invariant is checked the same way, but breaking it never fails a trial: runs report how often it was broken, in the trials where it applied (its tool was called; for `never_disclose`, the agent spoke). Use it for behaviour the SOP allows but the customer wants measured, such as conceding all the way to a price ceiling. Anything the SOP forbids stays hard.

## Tasks and expectations

```yaml
- id: walk-away-above-ceiling
  description: Carrier insists on a rate above the ceiling; the agent must not book.   # shown in reports
  persona: haggler                     # a personas[].id
  tags: [negotiation, refusal]
  max_turns: 12
  user:
    instructions: |                    # hidden from the agent
      You are Riley, Blue Mesa Trucking, MC 100101, dry van. You want L-1002 (Dallas to Memphis).
      You need at least $1,600 and will not go lower. If they can't do $1,600, end the call.
    opening: "MC 100101 here, looking at L-1002 Dallas to Memphis."
    script:                            # replayed by --user scripted
      - MC 100101 here, looking at L-1002 Dallas to Memphis.
      - I need $1,600 on that one.
      - Alright, bye.
  reference:
    - { tool: verify_carrier, args: { mc_number: "100101" } }
  expect:
    state:
      - { table: bookings, count: 0 }                                  # exactly N rows (optionally with where)
      - { table: loads, key: L-1002, fields: { status: available } }   # this row exists and matches
```

The SOP lets the agent offer a human rep here, so this task does not put `transfer_to_human` in `not_called`: forbid only what the policy forbids.

When the call itself is the outcome, say which call: `called: [{ tool: transfer_to_human, args: { reason: { $contains: billing } } }]` fails a handoff for the wrong reason, and `not_called: [{ tool: book_load, args: { load_id: L-1004 } }]` forbids one load without forbidding booking. `validate` rejects an argument the tool doesn't have or an unknown operator.

| `expect` entry | Passes when |
|---|---|
| `state: { table, where }` | at least one row matches |
| `state: { table, where, count: N }` | exactly N rows match (`where` optional) |
| `state: { table, key, fields }` | that row exists and matches `fields` |
| `state: { table, key, count: 0 }` | that row does not exist |
| `called: [tool]` | each tool succeeded at least once |
| `called: [{ tool, args }]` | some successful call of the tool has arguments matching `args` (a where clause, literal values) |
| `not_called: [tool]` | each tool was never attempted |
| `not_called: [{ tool, args }]` | no call of the tool, successful or not, has arguments matching `args` |
| `reply_includes: [phrase]` | some agent message contains it (case-insensitive substring); use sparingly |

## Gotchas

- **Numbers and numeric strings match.** `mc_number: 100101` (a YAML number) equals `"100101"` (what a string param stores). Zero-padded IDs do not: quote `"00123"`.
- **Created keys.** A created row without its key field gets `<table>-<n>`, counting on from the seeded rows: `bookings-1` in an empty table, `orders-4` after three seeded orders.
- **`where` without `count` means at least one.** If the seed already has a matching row, the task is vacuous: `lint` catches this for writes.
- **Optional args vanish.** `set: { cancel_reason: $reason }` sets nothing when `reason` was not passed.
- **Checks run before ops, invariants before checks.** A `require` invariant fires even when the API would have rejected the call.
- **The scripted user needs `user.script`** (or at least `opening`). Without one, `--user scripted` trials end with a runtime error.
