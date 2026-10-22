---
name: drafting-a-domain
description: Drafts a sandtable domain (sandtable.yaml, policy.md, tasks.yaml) from a customer's OpenAPI spec, SOP and call or chat transcripts with `sandtable init`, then makes it trustworthy. Covers resolving `sandtable review` items and TODO(review) notes, seed rows, `reference` calls, accepting drafted items, and getting `validate --strict` and `lint` to pass. Use when an engineer hands over discovery material (API spec, operating procedure, transcripts), starts a new simulation of a customer's workflow, or has a draft with pending review items or lint errors.
---

# Drafting a sandtable domain

A domain is a directory holding `sandtable.yaml` (world tables, tools, invariants, personas), `policy.md` (the customer's SOP) and `tasks.yaml`. `sandtable init` drafts it from discovery material. A person makes it true. You are done when `validate --strict` and `lint` both exit 0 and the engineer has accepted every drafted item.

Run the CLI as `npx sandtable-ai <command>`. It uses the project's copy when `sandtable-ai` is a dependency. Inside the sandtable repository itself, run `node src/cli.ts <command>`. If a flag below is rejected, trust `npx sandtable-ai <command> --help` over this file. Only if a command fails with `node: OpenSSL configuration error` and `openssl.cnf … Operation not permitted`, Claude Code's sandbox blocked Node from reading its OpenSSL config: rerun that command with `OPENSSL_CONF=/dev/null` in front, e.g. `OPENSSL_CONF=/dev/null npx sandtable-ai validate ./sandtable`. Don't add it otherwise.

This plugin's version matches the CLI release it documents. To know what the installed CLI supports, read `npx sandtable-ai --version`, `npx sandtable-ai <command> --help` and `validate`'s errors. Never read sandtable's own code to find out: not a copy under `~/.npm/_npx`, where npx caches several versions and the first one you find may not be the one that runs, and not the project's `node_modules/sandtable-ai`. For a Claude model on Bedrock, pass its plain name, such as `-m claude-sonnet-5-5`: sandtable maps it to the region's cross-region inference profile (`eu.anthropic.claude-sonnet-5-5` in `eu-west-1`) and passes a full profile ID or ARN through unchanged ([bring your agent](https://sandtable.dev/guides/bring-your-agent)).

## Install the CLI and its optional packages

Prefer one install in the project: it pins the version, and it is the only place the CLI finds its optional packages. A package installed anywhere else is invisible to `npx sandtable-ai`.

```bash
npm install --save-dev sandtable-ai @anthropic-ai/bedrock-sdk   # the CLI, plus Claude on Bedrock
npx sandtable-ai --version                                       # runs the project's copy
```

| You run | Install next to `sandtable-ai` |
|---|---|
| Claude on Bedrock: `--provider bedrock` for `init --sop`, `init --transcripts`, `run` | `@anthropic-ai/bedrock-sdk` |
| a non-Claude Bedrock agent: `--agent bedrock:<model-id>` | `@aws-sdk/client-bedrock-runtime` |
| either one with `--aws-profile` | `@aws-sdk/credential-providers` |

Claude on the Anthropic API (`ANTHROPIC_API_KEY`) needs none of them. Always name the package, `sandtable-ai`: npm's `sandtable` is an unrelated package. Without a project install, name every package with `-p`. The command is then the package's bin, `sandtable`: `sandtable-ai` after `-p` fails with "command not found".

```bash
npx -p sandtable-ai -p @anthropic-ai/bedrock-sdk sandtable init --sop ./discovery/sop.md -o ./sandtable --provider bedrock --region eu-west-1
```

Keep runs in the project: `run` writes to `.sandtable/runs/` unless `-o` names another directory. Give `-o` a path inside the project, never your session's scratch directory, which is cleaned up with the session.

## Ask before spending money

| Free and deterministic: run any time | Calls a model: get the engineer's go-ahead first |
|---|---|
| `init --openapi`, any `init … --dry-run`, `validate`, `review`, `lint`, `report` | `init --sop`, `init --transcripts` (Claude) |
| `run --agent noop --user scripted`, `demo` | `run` with a model agent (`claude`, `openai:`, `bedrock:`) or a model user (the default `claude`, `openai:`), `demo --live` |

Before a model-backed `init`, show the engineer what it will spend, even when they have already authorized model steps: an authorization isn't a budget. Get it from the CLI: the same command with `--dry-run` prints a plan line and stops, with no model call and no credentials needed:

```bash
npx sandtable-ai init --sop ./discovery/sop.md --transcripts ./discovery/calls -o ./sandtable -m claude-sonnet-5-5 --dry-run
# Plan: 10 model calls (1 for the SOP, 9 for transcripts) to claude-sonnet-5-5 on the Anthropic API; at most about $1.70 at list prices
```

After the dry run, write its plan to the engineer as a message of its own: the calls, the model, the provider and the dollar bound. Then:
- if they haven't authorized model steps, end your turn there and wait for their go-ahead (installing a package it needs, such as `@anthropic-ai/bedrock-sdk`, isn't one);
- if they have, write the plan as one line, such as `Plan: 5 calls to claude-sonnet-5-5 on Bedrock, at most about $0.94. You authorized model steps, so I'm running it.`, and then run the model-backed `init`.

The `Plan:` line in the command's output doesn't count: the engineer reads your reply, not the tool output. Never run the paid `init` straight after the dry run's output without your own plan message in between.

The calls are 1 for the SOP and 1 per `.txt` or `.md` transcript. The model is `claude-opus-5-5` at effort `high` unless `-m` names another. The bound assumes every call writes its 16,000-token maximum, so a real draft usually costs a fraction of it, and `init` prints the actual tokens and cost after each step.

For a first draft of many transcripts, suggest Sonnet, half the price per token: `npx sandtable-ai init --transcripts ./discovery/calls -o ./sandtable -m claude-sonnet-5-5`.

The `init` drafting steps use Claude: `ANTHROPIC_API_KEY`, or `--provider bedrock` with AWS credentials (`--region`, `--aws-profile`) and `@anthropic-ai/bedrock-sdk` installed as above. Do not paste customer documents into your own prompts or commit them to a public repository: `init --transcripts` scrubs emails, phone numbers and card numbers locally before anything is sent, and you should not undo that.

## Workflow

1. Draft with `init`.
2. `validate` until the schema and cross-references are clean. A `⚠` line is a warning, not an error. For a `never_disclose` field the agent is never shown, return its table from a tool. State the value in the policy only if the real agent's prompt holds it: putting a ceiling in the prompt just to clear the warning changes what the agent knows.
3. Resolve every item `review` lists, with the engineer.
4. Seed the world.
5. Give every write task a `reference`.
6. `lint` until it exits 0.
7. Measure the do-nothing floor.

### 1. Draft

Run `--openapi` on its own first: it's free. Then run the `--sop` and `--transcripts` command with `--dry-run` added, and show the engineer its `Plan:` line. Write the plan to them as a message of your own, with the calls and the dollar bound. If they already authorized model steps, run the command without `--dry-run` after that message; otherwise end your turn there and wait for their go-ahead. Never run a paid step without its dry run first.

```bash
npx sandtable-ai init --openapi ./discovery/openapi.yaml --sop ./discovery/sop.md --transcripts ./discovery/calls -o ./sandtable
```

The three steps run in this order because each builds on the last. The OpenAPI step creates tables and tools (deterministic, no model). The SOP step drafts invariants that may only name tools, params, tables and fields that already exist. The transcript step drafts tasks, personas and fictional seed rows against those tools. To add a step later, point `-o` at the existing domain, which must already validate:

```bash
npx sandtable-ai init --sop ./discovery/sop.md -o ./sandtable             # appends invariants
npx sandtable-ai init --transcripts ./discovery/calls -o ./sandtable      # appends tasks, personas, seed rows
```

- `--openapi` refuses to overwrite `sandtable.yaml`, `policy.md` or `tasks.yaml`. `--force` overwrites them and loses every hand edit, so never use it once review has started.
- With no OpenAPI spec, write the tools by hand first ([references/spec-cheatsheet.md](references/spec-cheatsheet.md)).
- Read every `!` line `init` prints: OpenAPI features it skipped (header and cookie params, array and object fields, `DELETE`), invariants or tasks it dropped and why, and quotes not found verbatim in the SOP. Tell the engineer about each one.
- `--model <id>` picks the drafting model (default `claude-opus-5-5`).

### 2. Validate

```bash
npx sandtable-ai validate ./sandtable
```

It checks the schema and every cross-reference (tables, tools, params, personas). Nothing else loads a domain that fails it, so fix its errors first.

### 3. Resolve review items

```bash
npx sandtable-ai review ./sandtable
```

It lists each pending tool, invariant and task, with the file and quote it came from. Review matters because drafted items become acceptance criteria. A wrong invariant fails a correct agent. A missing check lets a wrong agent pass. Either way the score lies, which is why reports say **provisional** while anything is pending.

- **Tools** carry `# TODO(review):` comments. Each note is one of three kinds (status codes such as 409 or 422 to encode as a `check`, side effects to add as ops, action endpoints whose placeholder `get` must become real ops). [references/review-notes.md](references/review-notes.md) has a before and after for each.
- **Invariants** come from the SOP. Confirm the quote is really in the SOP, that it states a hard rule (not a preference), and that the kind and direction match it: `lte` versus `gte`, every condition in a `require`, the right `same` args in a `before`. Every SOP rule no invariant checks is left as a `Soft rule, not checked` comment with a `why:` line; read those for rules the customer cares about that nothing checks (see references/review-notes.md).
- **Tasks** come from transcripts. Check each one against its chat, in this order:
  1. **The task keeps its chat's case.** The customer's account and membership level, the order and what is on it, the item, and what the customer asks for are the ones in the chat. Names and identifiers are replaced by fictional ones, consistently, and nothing else changes. A task whose seed rows or caller instructions tell a different case (a gold member drafted as a guest, another order, another item) tests something the chat doesn't show: fix its rows or instructions to match the chat, or drop it.
  2. **Then the end state.** For those facts, the expected end state is what the **SOP** requires, even when the human rep did something else. A rep who broke the SOP is a reason to expect the SOP's outcome, never a reason to change the customer's facts until the rep looks right.
  3. Names, companies and identifiers are fictional, and seed rows added for the task are plausible. A `TODO(review): copied from <file>` note names a value `init` found copied from the chat, such as a name, username, email or phone number: replace it everywhere it appears with a fictional one, consistently, then delete the note. The check misses details worded another way, such as an address with no house number or street suffix, or a name the draft spelled differently, so read the task for them too.

Show the engineer each item: the quote, what it will enforce, and your proposed fix. Accept it only after they agree, by changing `review: pending` to `review: accepted` (or deleting the line) and deleting the `TODO(review)` comments you resolved. Delete items that are wrong and cannot be fixed. Never bulk-accept to make `validate --strict` pass: an accepted item is a claim that it matches the customer's rules.

Also fix what `init` cannot know:
- Tool descriptions are what the agent reads. Rewrite placeholders such as `"GET /loads/{load_id} (no description in the spec: write one for the model)"` to say what the tool does, the way the customer's real tool description does.
- Tool names come from `operationId` or the path. Rename them to match what the agent under test actually calls, and update every reference to them.

### 4. Seed the world

Every table without examples gets `# TODO: add seed rows`, listing the fields seen in the spec. Every trial starts from a fresh copy of these rows, so they are the whole universe the agent can see. Seed one row per situation a task needs: an eligible customer and an ineligible one, an open order and a shipped one. Keep rows fictional, and give each one its key field.

```yaml
world:
  tables:
    carriers:
      key: mc_number
      rows:
        - { mc_number: "100101", name: Blue Mesa Trucking, insurance_status: valid, equipment: dry_van }
        - { mc_number: "100202", name: Northline Haulers, insurance_status: expired, equipment: dry_van }
```

A YAML number matches a string with the same digits (`100101` equals `"100101"`), but quote zero-padded IDs (`"00123"`) everywhere: seed rows, task expectations and `reference` args. Rows a tool creates without a key get `<table>-<n>`, where `n` starts after the seeded rows (`bookings-1` for an empty table).

### 5. Write `reference` calls

A `reference` is the shortest sequence of tool calls a correct agent would make, with exact arguments. `lint` replays it against a fresh world and requires every expectation to pass (except `reply_includes`) with no invariant broken. It proves the task is solvable, so a failure in a real run is the agent's and not an impossible task.

```yaml
- id: book-at-posted-rate
  user:
    instructions: |
      You are Dana, dispatcher at Blue Mesa Trucking, MC 100101. You want a dry van load Dallas to Atlanta at the posted rate.
      Once you have a confirmation number, say thanks and end the call.
    script:
      - Hi, this is Dana with Blue Mesa Trucking, MC 100101. Got anything Dallas to Atlanta for a dry van?
      - Sounds good, book it at that rate.
      - Thanks, bye.
  reference:
    - { tool: verify_carrier, args: { mc_number: "100101" } }   # required first by the `before` invariant
    - { tool: book_load, args: { load_id: L-1001, mc_number: "100101", rate: 2100 } }
  expect:
    state:
      - { table: bookings, where: { load_id: L-1001, mc_number: "100101" }, count: 1 }
    called: [verify_carrier, book_load]
```

- Include the reads that invariants demand (a `before: { first: verify_carrier, ... }` needs the `verify_carrier` call in the reference).
- Use the values the policy allows: a negotiated rate inside the band the expectation accepts, an amount under the refund cap.
- Refusal tasks need no reference (lint shows `solvable ?`). A read-only reference still helps: it proves the expected "nothing changed" state holds after a correct agent looks things up.
- When the correct agent's call is one the API rejects (the lookup of an unknown MC number, a purchase that doesn't validate), add it with `expect_error: true`, or with text its error contains such as `expect_error: not found`. `lint` then requires that call to fail, so the task is proven `solvable` and a domain edit that drops the rejection shows up.

### 6. Lint

```bash
npx sandtable-ai lint ./sandtable
```

Each task gets a line such as `✗ my-task  (write · NOT ready · NOT solvable · noop passes)`, followed by its errors. It makes no model calls and exits 1 on any error.

| Lint message | What it means | Fix |
|---|---|---|
| `nothing is graded: add state or called expectations` | the task can never fail | add `expect.state` (preferred) or `called` |
| `expect.state[i] needs a row in <table> that is not seeded and no tool can create or change` | unreachable | seed the row, or resolve the tool note that should create or update it |
| `vacuous: the seed already satisfies the expected state, so a do-nothing agent passes` | the task tests nothing | tighten `where` to the row the agent must create, or fix the seed |
| `reference[i] <tool> failed: <error>` | a call in the reference errors | fix the args, the seed rows, or the tool's `checks` |
| `reference does not pass: <check id>: <detail>` | a correct agent would still fail | the reference, the expectation or the tool ops are wrong: decide which with the SOP |
| `no reference: add the tool calls a correct agent would make` (warning) | solvability unproven | add a `reference` |
| `tools.<tool>.ops[i]: "$x" never resolves: tool "<tool>" has no param "x"` (also from `validate`, and for `checks[i]`) | a `$x` or `${x}` names no param of the tool, so it would be empty at run time | add the param or fix the name. A literal such as `"$/hr"` stays text, but a whole `"$USD"` is a reference |

Lint counts a task as a write when it expects rows to exist (a `state` entry without `key` whose `count` is absent or positive) or lists a writing tool in `called`. An update checked with `key` plus `fields` is labelled `no-write`, so it is never flagged as vacuous: check that its line says `noop fails`, or add the writing tool to `called`.

### 7. Gates and the floor

```bash
npx sandtable-ai validate ./sandtable --strict && npx sandtable-ai lint ./sandtable
npx sandtable-ai run ./sandtable --agent noop --user scripted
```

The first line is the CI gate: `--strict` fails while anything is pending. The second runs the do-nothing baseline offline (every task needs a `user.script`): its pass rate is the share of the suite that rewards doing nothing, and a real agent's score means little until you know it. Then hand over to the `running-and-reading-results` skill. For writing more tasks, use `writing-good-tasks`.

## References

- [references/spec-cheatsheet.md](references/spec-cheatsheet.md): tools, ops, checks, templates, where operators, the six invariant kinds, expectations and their gotchas.
- [references/review-notes.md](references/review-notes.md): resolving each kind of `TODO(review)` note, and checklists for drafted invariants and tasks.
