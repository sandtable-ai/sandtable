# Rehearse an OpenAI Agents SDK agent

`agent.ts` is a [module agent](https://sandtable.dev/guides/bring-your-agent#your-agent-as-a-js-or-ts-module) for an agent built with the [OpenAI Agents SDK for JavaScript](https://openai.github.io/openai-agents-js/) (`@openai/agents`). It wraps an `Agent` and a `Runner` in sandtable's `AgentAdapter`:

- sandtable calls the default export with no options and opens one session per trial. Each session keeps its own history: the Runner's `result.history` goes back in as the next turn's input.
- Each of the domain's tools becomes a function tool whose `execute` calls sandtable's `callTool`. The call runs against the trial's simulated world, is checked against the domain's invariants and is graded. Nothing reaches a real system.
- Tools use strict mode, the SDK's default. sandtable's schemas have optional parameters; the SDK sends them to the model as nullable and drops the nulls before `execute`, so sandtable sees only the arguments the model set.
- A failed call (`ok: false`) returns `{ error }` as the tool output. A thrown error would reach the model only as the SDK's generic "An error occurred while running the tool" message.
- Each trial's turns share a trace `groupId` (the sandtable session id), so they show up as one conversation in the OpenAI traces dashboard.
- Past `maxTurns` (12 model calls per user turn) the Runner throws, and sandtable counts the trial as a runtime failure.

To rehearse your own agent, change `buildAgent`: pass your own instructions instead of sandtable's default prompt, and keep your function tool names and parameters (the domain's tools mirror them) with each `execute` swapped for `callTool`.

## Run it

From the repository root:

```bash
npm ci && npm run build                      # the example imports sandtable-ai's types from dist/
(cd examples/frameworks/openai-agents && npm ci)
export OPENAI_API_KEY=...                    # the agent
export ANTHROPIC_API_KEY=...                 # Claude as the default simulated caller
npm run sandtable -- run examples/freight --agent examples/frameworks/openai-agents/agent.ts -k 4
```

The model is `OPENAI_MODEL`, default `gpt-5.6-terra`. Add `--user scripted` to replay each task's script instead of a Claude caller; then only `OPENAI_API_KEY` is needed. Running a `.ts` agent needs Node 22.18 or later.

## Check it offline

```bash
cd examples/frameworks/openai-agents
npm run check
```

No model calls and no API key. Tracing is turned off in the check. The check:

- typechecks `agent.ts` against the SDK's and sandtable's types
- drives the adapter with the SDK's `ScriptedModel` (from `@openai/agents/testing`), which replays a scripted conversation
- runs sandtable's `runSuite` on the freight task `book-at-posted-rate` with the scripted caller, and asserts that `verify_carrier`, `search_loads` and `book_load` ran in the simulated world, that strict mode's nulls never reached it, that the trial passed, and that the last model call still saw the first turn
- calls the session directly with a failing `callTool`, and asserts that the error text reached the model

Not checked: a live run with a real model. It needs API keys and has not been run.

## Use it in your project

Until the first release, `package.json` depends on this repository with `"sandtable-ai": "file:../../.."`, and the types come from the root's `dist/`, so run `npm run build` at the root first. After the first release, replace it with `"sandtable-ai": "^0.1.0"`, copy `agent.ts` next to your agent, and run `npx sandtable-ai run ./my-domain --agent ./agent.ts`.

Built against `@openai/agents` 0.20.0.
