# Rehearse a Vercel AI SDK agent

`agent.ts` is a [module agent](https://sandtable.dev/guides/bring-your-agent#your-agent-as-a-js-or-ts-module) for an agent built with the [Vercel AI SDK](https://ai-sdk.dev) (`ai`). It wraps a `ToolLoopAgent` in sandtable's `AgentAdapter`:

- sandtable calls the default export with no options and opens one session per trial. Each session keeps its own `ModelMessage[]` history.
- Each of the domain's tools becomes an AI SDK tool (`dynamicTool` with `jsonSchema`) whose `execute` calls sandtable's `callTool`. The call runs against the trial's simulated world, is checked against the domain's invariants and is graded. Nothing reaches a real system.
- A failed call (`ok: false`) throws inside `execute`, so the AI SDK sends the error to the model as a tool error it can correct.
- Token usage from each step goes to `recordUsage`, so the report shows tokens and cost.

To rehearse your own agent, change `buildAgent`: pass your own instructions instead of sandtable's default prompt, and keep your tool names and input schemas (the domain's tools mirror them) with each `execute` swapped for `callTool`.

## Run it

From the repository root:

```bash
npm ci && npm run build                      # the example imports sandtable-ai's types from dist/
(cd examples/frameworks/vercel-ai-sdk && npm ci)
export ANTHROPIC_API_KEY=...                 # the agent, and Claude as the default simulated caller
npm run sandtable -- run examples/freight --agent examples/frameworks/vercel-ai-sdk/agent.ts -k 4
```

The model is `ANTHROPIC_MODEL`, default `claude-opus-5-5`. To use another provider, install it (for example `@ai-sdk/openai`) and change the `model` line in `agent.ts`. Add `--user scripted` to replay each task's script instead of a Claude caller. Running a `.ts` agent needs Node 22.18 or later.

## Check it offline

```bash
cd examples/frameworks/vercel-ai-sdk
npm run check
```

No model calls and no API key. The check:

- typechecks `agent.ts` against the AI SDK's and sandtable's types
- drives the adapter with the AI SDK's `MockLanguageModelV4`, which replays a scripted conversation
- runs sandtable's `runSuite` on the freight task `book-at-posted-rate` with the scripted caller, and asserts that `verify_carrier`, `search_loads` and `book_load` ran in the simulated world, the trial passed, the last model call still saw the first turn, and token usage reached the report
- calls the session directly with a failing `callTool`, and asserts that the error reached the model

Not checked: a live run with a real model. It needs API keys and has not been run.

## Use it in your project

Until the first release, `package.json` depends on this repository with `"sandtable-ai": "file:../../.."`, and the types come from the root's `dist/`, so run `npm run build` at the root first. After the first release, replace it with `"sandtable-ai": "^0.1.0"`, copy `agent.ts` next to your agent, and run `npx sandtable-ai run ./my-domain --agent ./agent.ts`.

Built against `ai` 7.0.143 and `@ai-sdk/anthropic` 4.0.82.
