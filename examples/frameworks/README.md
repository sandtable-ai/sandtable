# Rehearse agents built with frameworks

Worked examples that rehearse an agent built with a popular framework. Each folder has a one-file adapter, a README and an offline check: no model calls and no API keys, run in CI on every pull request. The guide is [Rehearse an agent built with a framework](https://sandtable.dev/guides/frameworks).

| Example | Framework | Integration | What the offline check verifies |
|---|---|---|---|
| [`vercel-ai-sdk`](vercel-ai-sdk) | Vercel AI SDK (`ai`) | module agent | Typecheck. `MockLanguageModelV4` replays a scripted conversation and `runSuite` runs freight task `book-at-posted-rate` end to end with the scripted caller: tool calls reach the simulated world, the trial passes, history carries across turns. A failed call reaches the model as a tool error. |
| [`openai-agents`](openai-agents) | OpenAI Agents SDK (`@openai/agents`) | module agent | Typecheck. `ScriptedModel` replays a scripted conversation and `runSuite` runs the same freight task end to end: tool calls reach the simulated world without strict mode's nulls, the trial passes, history carries across turns. A failed call's error text reaches the model. |
| [`claude-agent-sdk`](claude-agent-sdk) | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) | module agent | Typecheck and import. An MCP client calls the adapter's in-process server: it lists the domain's tools, and its calls run in the simulated world. The `query()` loop needs a model and is not checked. |
| [`pipecat`](pipecat) | Pipecat | HTTP step protocol | See its README. |
| [`livekit-agents`](livekit-agents) | LiveKit Agents | HTTP step protocol | See its README. |
| [`http-service`](http-service) | none: Python on the Anthropic Messages API | HTTP step protocol | See its README. |

None of the examples has been run live against a model in this repository. A live run needs your API keys.

## Run the checks

TypeScript examples (Node 22.18 or later). Until the first release they depend on this repository (`"sandtable-ai": "file:../../.."`) and read its types from `dist/`, so build the root first:

```bash
npm ci && npm run build
cd examples/frameworks/vercel-ai-sdk     # or openai-agents, claude-agent-sdk
npm ci && npm run check
```

Python examples, with [uv](https://docs.astral.sh/uv/):

```bash
uv run --directory examples/frameworks/pipecat python -m pytest -q
```

These folders have their own dependencies. They are not part of the `sandtable-ai` npm package, and the root `npm test` and `npm run typecheck` skip them.
