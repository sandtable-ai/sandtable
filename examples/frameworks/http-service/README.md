# Plain HTTP service (Python, Claude Messages API)

An agent that runs as its own HTTP service, with no agent framework: a Python standard-library server and the `anthropic` SDK. It speaks sandtable's [HTTP step protocol](https://sandtable.dev/reference/http-protocol), so sandtable can rehearse it against the bundled freight example.

| File | What it is |
|---|---|
| `agent.py` | The agent and its HTTP server, in one file |
| `test_agent.py` | Offline tests, with a scripted fake in place of the Claude client |
| `pyproject.toml` | Dependencies, managed by [uv](https://docs.astral.sh/uv/) |

## How it maps

The protocol's fields line up with the Messages API, so there is nothing to bridge:

| sandtable sends or expects | Messages API |
|---|---|
| `message` | a user turn |
| `tool_calls`, with `id`, `name`, `arguments` | the response's `tool_use` blocks, with the `tool_use` id as `id` |
| `tool_results` | `tool_result` blocks, with `is_error` set when `ok` is false |
| `reply` | the text of a response that ends the turn |

The service keeps one message history per `session_id`, in memory. It sends the whole assistant content back on the next request, thinking blocks included.

## Run it live

You need an Anthropic API key. Every trial calls the model, so a run costs money.

```bash
cd examples/frameworks/http-service
export ANTHROPIC_API_KEY=...
uv run python agent.py        # serves http://127.0.0.1:8787/step
```

In a second terminal, from the repository root:

```bash
npx sandtable-ai run examples/freight --agent http://localhost:8787/step --user scripted
```

Until `sandtable-ai` is published on npm, run the same command from a clone of this repository with `npm run sandtable -- run examples/freight --agent http://localhost:8787/step --user scripted`.

`--user scripted` replays each task's scripted caller lines, so only the agent calls a model. For a caller that adapts to what the agent says, use Claude as the simulated user, for example `--user claude:claude-haiku-5-5`. Add `-k 4` for pass^4, or `-t book-at-posted-rate,expired-insurance` to run a few tasks.

| Variable | Default | What it sets |
|---|---|---|
| `AGENT_MODEL` | `claude-sonnet-5-5` | the model the agent runs on, such as `claude-opus-5-5` or `claude-haiku-5-5` |
| `PORT` | `8787` | the port the service listens on |

Requests opt into server-side fallback (`fallbacks="default"`): if the model declines a request for policy reasons, the API retries it on the fallback model Anthropic recommends. Remove the `betas` and `fallbacks` arguments in `agent.py` to turn it off.

## Use your own agent

- Set `SYSTEM_PROMPT` in `agent.py` to your agent's prompt. With `None`, the agent uses the prompt sandtable sends: the domain's description and policy.
- The agent uses the tool definitions sandtable sends. If your agent has its own, their names and arguments must match the domain's tools, because sandtable runs every call against its simulated world.
- If your service already exists, you need only `step()`: put it behind the route your service already has.

## What is verified

- **Offline, in CI:** `uv run --directory examples/frameworks/http-service python -m pytest -q`. The tests start the server with a scripted fake in place of the Claude client, then POST protocol requests to it. They check that `tool_use` blocks become `tool_calls` with their ids, that two calls from one response come back in one step, that `tool_results` become `tool_result` blocks (failed calls as errors), that end-of-turn text becomes the `reply`, that each `session_id` keeps its own history, and that a refusal becomes a fixed reply.
- **Offline, where Node 22.18 or later and the repository's `node_modules` are present:** the last test runs the real sandtable CLI against the server on the freight task `book-at-posted-rate`, and expects pass^1 of 100%. CI's Python job has no Node, so the test is skipped there.
- **Not verified:** a live run with Claude. It needs an API key and has not been run, so there is no score for this agent yet.

## Limits

- Sessions stay in memory until the service restarts. The protocol has no end-of-session call.
- If a turn uses up sandtable's 16 rounds of tool calls, sandtable sends the next message without the last results. The Messages API needs a `tool_result` for every `tool_use`, so that request fails with status 502 and the trial ends as a runtime failure.
- A slow model call stalls its trial, because sandtable does not time out requests.
- sandtable cannot see this agent's model calls, so reported tokens and cost cover only the simulated user.
