# Rehearse agents built with frameworks

Worked examples that rehearse an agent built with a popular framework. Each folder has a one-file adapter, a README and an offline check: no model calls and no API keys, run in CI on every pull request. The guide is [Rehearse an agent built with a framework](https://sandtable.dev/guides/frameworks).

| Example | Framework | Integration | What the offline check verifies |
|---|---|---|---|
| [`vercel-ai-sdk`](vercel-ai-sdk) | Vercel AI SDK (`ai`) | module agent | Typecheck. `MockLanguageModelV4` replays a scripted conversation and `runSuite` runs freight task `book-at-posted-rate` end to end with the scripted caller: tool calls reach the simulated world, the trial passes, history carries across turns. A failed call reaches the model as a tool error. |
| [`openai-agents`](openai-agents) | OpenAI Agents SDK (`@openai/agents`) | module agent | Typecheck. `ScriptedModel` replays a scripted conversation and `runSuite` runs the same freight task end to end: tool calls reach the simulated world without strict mode's nulls, the trial passes, history carries across turns. A failed call's error text reaches the model. |
| [`claude-agent-sdk`](claude-agent-sdk) | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) | module agent | Typecheck and import. An MCP client calls the adapter's in-process server: it lists the domain's tools, and its calls run in the simulated world. The `query()` loop needs a model and is not checked. |
| [`pipecat`](pipecat) | Pipecat (`pipecat-ai`) | HTTP step protocol | A text pipeline (no STT, TTS or transport) with a fake LLM service: protocol requests and replies, tool calls suspended until sandtable posts results, per-session history, empty results, reused call ids and abandoned turns. One test keeps the real Anthropic service and replaces only its network client. |
| [`livekit-agents`](livekit-agents) | LiveKit Agents (`livekit-agents`) | HTTP step protocol | A text-only `AgentSession` with a fake LLM: protocol requests and replies, tool calls suspended until sandtable posts results, per-session history, reused call ids, abandoned turns and shutdown. One test keeps the real Anthropic plugin and replaces only its network client. |
| [`http-service`](http-service) | none: Python on the Anthropic Messages API | HTTP step protocol | A fake Messages API client: `tool_use` blocks become `tool_calls`, `tool_results` go back as `tool_result` blocks, and history is kept per session. |

None of the examples has been run live against a model in this repository. A live run needs your API keys.

## Run the checks

TypeScript examples (Node 22.18 or later). They depend on this repository (`"sandtable-ai": "file:../../.."`), so they check the code next to them, and read its types from `dist/`. Build the root first:

```bash
npm ci && npm run build
cd examples/frameworks/vercel-ai-sdk     # or openai-agents, claude-agent-sdk
npm ci && npm run check
```

Python examples, with [uv](https://docs.astral.sh/uv/). When Node 22.18+ and the root `node_modules` are present, each suite's last test also runs the real CLI against the adapter:

```bash
uv run --directory examples/frameworks/pipecat python -m pytest -q     # or livekit-agents, http-service
```

These folders have their own dependencies. They are not part of the `sandtable-ai` npm package, and the root `npm test` and `npm run typecheck` skip them.
