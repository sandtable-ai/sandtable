# Domain spec reference

A domain lives in a directory with a `sandtable.yaml`. Any top-level value that is a relative path to an existing `.md`, `.yaml` or `.yml` file is inlined, so you can keep `policy: ./policy.md` and `tasks: ./tasks.yaml` in separate files.

Run `sandtable validate <dir>` after every edit. It checks the schema and every cross-reference (tables, tools, params, personas).

```yaml
name: string                # required
description: string         # who the agent works for; shown to both agent and simulated user
policy: string | ./file.md  # the SOP the agent must follow (the reference agent's system prompt)
max_turns: 20               # user turns per trial before it is cut off
world: { tables: ... }
tools: [...]
invariants: [...]
personas: [...]
tasks: [...] | ./tasks.yaml
```

## Templates

Inside tool `ops`, `checks`, invariant `where` clauses and task assertions:

- `"$arg"` is replaced by the tool call's argument value, keeping its type.
- `"${arg}"` interpolates inside a longer string: `"Load ${load_id} is not available"`.
- A condition whose argument was not passed (an optional param) is dropped, so it filters nothing.

## Where clauses

`where`, `fields` and `when` are maps of field to condition. A plain value means equality. An object of operators means all of them must hold:

| Operator | Meaning |
|---|---|
| `$eq`, `$ne` | equal / not equal |
| `$in`, `$nin` | in / not in a list |
| `$gt`, `$gte`, `$lt`, `$lte` | numeric comparison (strings compare lexically, so ISO dates work) |
| `$exists` | `true`: field is set and not null |
| `$contains` | case-insensitive substring |

## world

```yaml
world:
  tables:
    loads:
      key: load_id            # primary key field
      rows:                   # seed data; each trial starts from a fresh copy
        - { load_id: L-1001, origin: "Dallas, TX", status: available, max_rate: 2350 }
    bookings:
      key: booking_id         # created rows without a key get "<table>-<n>"
```

## tools

A tool is what the agent sees (name, description, JSON-schema params) plus what it does to the world.

```yaml
- name: book_load                       # ^[a-zA-Z0-9_-]{1,64}$
  description: What it does, written for a model.
  params:
    load_id: { type: string }           # string | number | integer | boolean
    rate: { type: number, description: "All-in USD" }
    note: { type: string, required: false }
    equipment: { type: string, required: false, enum: [dry_van, reefer] }
    status: { type: string, required: false, default: available }   # used when the agent omits it
  checks:                               # preconditions the real API enforces; failing one = tool error, no writes
                                        # (skipped when the key comes from an optional arg that was not passed)
    - { table: loads, key: $load_id, where: { status: available }, error: "Load ${load_id} is not available" }
  ops:                                  # run in order, atomically (all or nothing)
    - create: bookings
      values: { load_id: $load_id, rate: $rate }
    - update: loads
      key: $load_id
      set: { status: booked }
  returns: 0                            # which op's result the agent gets back (default 0)
```

| Op | Effect | Returns |
|---|---|---|
| `get: <table>, key` | read one row; error if missing | the row |
| `list: <table>, where?, limit?` | filter rows | array of rows |
| `create: <table>, values` | insert a row | the new row |
| `update: <table>, key, set` | merge fields into a row; error if missing | the updated row |
| `respond: <value>` | no state change | the value (templated) |

Arguments are validated before anything runs. Unknown argument names, missing required ones and wrong types come back to the agent as tool errors. Representations are coerced leniently: `"2,100"` becomes `2100` for a number param, and `100101` becomes `"100101"` for a string param.

## invariants

Checked before every tool call, against the world as it is at that moment. A violation fails the trial even if the call itself then errors: attempting the forbidden action is the bug.

```yaml
# `then` only after a successful `first` with the same values for `same`
- id: verify-before-book
  description: ...
  before: { first: verify_carrier, then: book_load, same: [mc_number] }

# the record keyed by an argument must exist and match `where`
- id: eligible-carrier
  description: ...
  require: { tool: book_load, table: carriers, key_arg: mc_number, where: { insurance_status: valid } }

# numeric bound on an argument: a constant or another record's field
- id: rate-ceiling
  description: ...
  limit: { tool: book_load, arg: rate, lte: { table: loads, key_arg: load_id, field: max_rate } }

# two referenced records must agree on a field
- id: equipment-match
  description: ...
  match:
    tool: book_load
    left: { table: carriers, key_arg: mc_number, field: equipment }
    right: { table: loads, key_arg: load_id, field: equipment }

# never call a tool (optionally: never with matching args)
- id: no-refunds-over-500
  description: ...
  never: { tool: issue_refund, when: { amount: { $gt: 500 } } }
```

## personas and tasks

```yaml
personas:
  - id: haggler
    description: A seasoned owner-operator who always pushes on rate.

tasks:
  - id: walk-away-above-ceiling
    description: Shown in reports.
    persona: haggler
    tags: [negotiation, refusal]
    max_turns: 12                      # overrides the domain default
    user:
      instructions: |                  # hidden goal + private facts; the agent never sees this
        You need at least $1,600 and will not go lower...
      opening: "MC 100101, calling about L-1002."   # optional fixed first line
      script: [ ... ]                  # optional fixed turns for --user scripted
    reference:                         # optional: what a correct agent would do; `sandtable lint` replays it
      - { tool: verify_carrier, args: { mc_number: "100101" } }
    expect:
      state:
        - { table: bookings, count: 0 }                                # exactly N rows (with optional where)
        - { table: bookings, where: { load_id: L-1004 } }              # at least one matching row
        - { table: loads, key: L-1002, fields: { status: available } } # this row matches
        - { table: loads, key: L-9999, count: 0 }                      # this row does not exist
      called: [verify_carrier]          # each must have succeeded at least once
      not_called: [transfer_to_human]   # never attempted
      reply_includes: ["confirmation"]  # some agent message contains it (case-insensitive); use sparingly
```

The simulated user ends the conversation by emitting `###STOP###` when its goal is met, impossible, or it has been handed off. Trials that hit `max_turns` are still graded on the end state.

## Linting tasks

`sandtable lint <domain>` proves, without any model call, that each task is worth grading:

- **ready**: rows the expectations need are seeded, or some tool can create or change them.
- **solvable**: the task's `reference` calls, replayed against a fresh world, pass every expectation and break no invariant.
- **non-vacuous**: a do-nothing agent fails every task that expects a write. If it passes, the seed already satisfies the expectation.
- **graded**: the task has state or `called` expectations.

It exits non-zero on errors, so it belongs in CI next to `validate --strict`.

## Reading scores

Run the `noop` baseline first: `sandtable run <domain> --agent noop --user scripted`. It never calls a tool, so it passes exactly the tasks whose success is "nothing happened": refusals, handoffs that only need a polite answer, and missing-information cases. On the freight example it scores 50%. A real agent's score means little until you know that floor. Balance refusal tasks with tasks that require a write, and compare per-tag scores.

## Results

`run` writes `results.json` (a `SuiteResult`, with every trial's transcript, tool calls, checks and world diff) and `report.html` (self-contained, no external assets). `sandtable report results.json` re-renders the HTML.

Each trial also records how long the agent took to answer every user turn (tool calls included), and the tokens its model calls used. Adapters report tokens through `recordUsage`; the Claude adapters do this automatically. Runs show p50/p95 agent turn latency and an estimated cost at list prices (`PRICES` in `src/run/usage.ts`). Cost shows as `n/a` for models without a known price.

## HTTP agent protocol

`--agent https://your-agent/step` sends one POST per step:

```jsonc
// request
{
  "session_id": "walk-away-above-ceiling#0",   // stable per trial: key your conversation state on it
  "system": "...",                             // sandtable's default prompt; ignore it if your agent has its own
  "tools": [{ "name": "...", "description": "...", "input_schema": { } }],
  "message": "I need $1,600 on that one.",     // a new user turn, or:
  "tool_results": [{ "id": "c1", "ok": true, "result": { } }]  // results of your previous tool_calls
}

// response: either finish the turn...
{ "reply": "Best I can do is $1,375." }
// ...or ask sandtable to run tools against the simulated world
{ "tool_calls": [{ "id": "c1", "name": "get_load", "arguments": { "load_id": "L-1002" } }] }
```
