# `rehearse init`: drafting a domain

Writing a domain by hand is the main cost of adopting rehearse. `init` drafts one from what a customer hands over during discovery, then leaves a person to review it. Every inferred item stays visible as a `TODO` until someone accepts it.

```bash
rehearse init --openapi path/to/openapi.yaml -o rehearsal
rehearse validate rehearsal
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
rehearse review rehearsal              # list what is pending, with sources
rehearse validate rehearsal --strict   # fails while anything is pending (use in CI)
```

While items are pending, runs still work, but their reports are marked **provisional**. To accept an item, change `review: pending` to `review: accepted` or delete the line.

## Next: SOP and transcripts

Drafting invariants from an SOP and tasks from call transcripts is in progress: see the issues labelled `area:init`.
