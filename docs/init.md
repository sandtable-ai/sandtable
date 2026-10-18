# `sandtable init`: drafting a domain

Writing a domain by hand is the main cost of adopting sandtable. `init` drafts one from what a customer hands over during discovery, then leaves a person to review it. Every inferred item stays visible as a `TODO` until someone accepts it.

```bash
sandtable init --openapi path/to/openapi.yaml -o sandtable
sandtable validate sandtable
```

## From an OpenAPI spec (deterministic)

No model is involved: the same spec always produces the same draft.

| OpenAPI | Draft |
|---|---|
| `/loads/{load_id}` | table `loads` with key `load_id` |
| a collection without an item path | key from the schema (`<singular>_id`, then `id`), else `<singular>_id` |
| `GET /loads/{load_id}` | tool with `get: loads, key: $load_id` |
| `GET /loads?origin=&status=` | tool with `list: loads, where: {...}`; free-text strings match with `$contains`, enums and numbers with equality |
| query param `default` | param `default`, applied when the agent omits it |
| `limit`, `offset`, `page`, `cursor`, … | ignored (pagination) |
| `POST /bookings` | tool with `create: bookings, values: {body fields}` |
| `PUT/PATCH /orders/{id}` | tool with `update: orders, key: $id, set: {body fields}` |
| `/customers/{customer_id}/orders` | parent params become filters and create values |
| `POST /orders/{id}/cancel` (no GET) | action: a `get` on the parent plus a review note to model the effect |
| a body param named like another table's key | existence `check` on that table |
| `example` on a response schema | seed rows |

It cannot infer some things, so they become `# TODO(review):` comments next to the tool:

- **409/422/400/403 responses**: encode the condition as a `check` with a `where`.
- **Side effects in the description** ("the load becomes booked"): add the `update` op on the other table.
- **Action endpoints**: replace the placeholder `get` with the ops that model the action.

It also leaves out several things and lists them as warnings:
- header and cookie params
- non-scalar fields (arrays, objects)
- `DELETE` operations

Tables with no examples get a `TODO: add seed rows` comment that lists the fields seen in the spec.

## Reviewing a draft

Drafted invariants and tasks carry `review: pending` and a `source` (the file and the quote they came from). Tools with review notes are marked the same way.

```bash
sandtable review sandtable              # list what is pending, with sources
sandtable validate sandtable --strict   # fails while anything is pending (use in CI)
```

While items are pending, runs still work, but their reports are marked **provisional**. Run `sandtable lint` too: it catches drafted tasks that are vacuous, unreachable or unsolvable before anyone spends money running them. To accept an item, change `review: pending` to `review: accepted` or delete the line.

## From an SOP (Claude, grounded)

```bash
sandtable init --openapi api.yaml --sop policy.md -o sandtable   # draft, then add invariants
sandtable init --sop policy.md -o sandtable                       # add invariants to an existing domain
```

Claude reads the SOP alongside the domain's tools, params, tables and known fields, and proposes invariants in the five existing kinds, using structured outputs. Nothing it proposes is trusted as-is:

- every invariant must **quote** the SOP. A quote that does not appear verbatim gets a warning.
- proposals that reference an unknown tool, param, table or field, or that are incomplete, are **dropped**, and the reason is printed.
- survivors are appended to the domain (existing comments are kept) with `review: pending` and `source: { file, quote }`.
- rules that cannot be checked from tool calls (wording, disclosure, read-backs) are written as **soft rule** comments, for the soft-checks feature.

The SOP also becomes `policy.md` when the domain still has the placeholder. Pass `--model` to choose the drafting model (default `claude-opus-5-5`).

## From call or chat transcripts (Claude, grounded)

```bash
sandtable init --transcripts calls/ -o sandtable          # a directory of .txt/.md files, or one file
sandtable init --openapi api.yaml --sop policy.md --transcripts calls/ -o sandtable   # all three steps
```

Each transcript becomes one task:
- a hidden-goal instruction for a simulated caller who behaves like the real one
- a scripted version of the caller's turns, so the task also runs offline
- tags, and a new or reused persona
- the end state the world must reach **if the agent follows the policy**. When the human rep broke the policy, the expectation follows the policy, not the rep.

Guardrails:
- **PII is scrubbed locally before anything is sent**: emails, phone numbers and card-like numbers. Short identifiers such as order or MC numbers are kept. The model is told to replace names and companies with fictional ones.
- When the world lacks rows for the scenario, the draft adds **fictional seed rows**. A row whose key collides with an existing one drops the task.
- Tasks that would grade nothing (no state and no `called` expectations), or that fail validation, are dropped with the reason.
- Survivors are `review: pending`, with the transcript and a verbatim excerpt as `source`.
