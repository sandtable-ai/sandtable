# LiveKit Agents

Rehearse a [LiveKit Agents](https://github.com/livekit/agents) voice agent with sandtable. This server runs the agent's LLM layer as text: the same LLM, instructions and function tools the agent uses, in an `AgentSession` with no room, speech-to-text, text-to-speech or voice activity detection. It speaks sandtable's [HTTP step protocol](https://sandtable.dev/reference/http-protocol).

**What this rehearses:** the agent's decisions and tool use, as text. Which tools it calls, with which arguments, what it tells the caller, and whether it follows the policy. **What it does not:** audio, speech recognition, text-to-speech, turn-taking, interruptions or latency. Test those with your voice stack.

| File | What it is |
|---|---|
| `agent.py` | The bridge and its HTTP server, in one file. Your agent's config goes at the top |
| `test_agent.py` | Offline tests, with a fake LLM and a fake Anthropic client |
| `pyproject.toml` | Dependencies, managed by [uv](https://docs.astral.sh/uv/) |

## How it works

The step protocol inverts control: sandtable runs the tools, and LiveKit Agents expects to run them itself. The server bridges the two.

- Each sandtable session gets its own `AgentSession`, started on text alone. A user message runs one turn with `session.run(user_input=...)`.
- The agent's tools are raw-schema function tools (`function_tool(..., raw_schema=...)`), built from the JSON-schema tools sandtable sends. Each one waits for sandtable to run its call.
- The agent overrides `llm_node`. When the model's response stream ends, the calls it made go back to sandtable as one `tool_calls` step.
- The next request's `tool_results` complete the waiting tools. A failed call raises `ToolError`, so the model sees the error. LiveKit adds the results to the chat context and runs the LLM again, as it would after the agent's real tools.
- When the turn ends, everything the agent said in it goes back as the `reply`.
- If the LLM fails, the step fails with status 502, and sandtable ends the trial as a runtime failure.
- If a turn uses up sandtable's 16 rounds of tool calls, sandtable sends the next message without the last results. That turn cannot resume, so the step fails with status 409 and the trial ends as a runtime failure. With LiveKit's default `max_tool_steps` of 3, the turn ends before that.

## Plug in your agent

Edit the three functions at the top of `agent.py`:

- `create_llm()` returns the LLM your agent uses. The example uses the Anthropic plugin on `claude-sonnet-5-5`.
- `instructions(step)` returns your agent's instructions. The example returns the prompt sandtable sends (the domain's description and policy).
- `create_session()` returns your `AgentSession` settings without audio. Keep your `max_tool_steps`: by default, after 3 rounds of tool calls in one turn, LiveKit has the model answer without tools. sandtable allows 16 rounds.

The tool names and arguments come from the domain, because sandtable runs every call against its simulated world. Your agent's real tools do not run here. If your agent class overrides `llm_node`, make `RehearsalAgent` start from your override.

## Run it live

You need an Anthropic API key, or the key for the LLM `create_llm` returns. Every trial calls the model, so a run costs money.

```bash
cd examples/frameworks/livekit-agents
export ANTHROPIC_API_KEY=...
uv run python agent.py        # serves http://127.0.0.1:8787/step
```

In a second terminal, from the repository root:

```bash
npx sandtable-ai run examples/freight --agent http://localhost:8787/step --user scripted
```

Until `sandtable-ai` is published on npm, run the same command from a clone of this repository with `npm run sandtable -- run examples/freight --agent http://localhost:8787/step --user scripted`.

`--user scripted` replays each task's scripted caller lines, so only the agent calls a model. For a caller that adapts to what the agent says, use Claude as the simulated user, for example `--user claude:claude-haiku-5-5`. Add `-k 4` for pass^4.

| Variable | Default | What it sets |
|---|---|---|
| `AGENT_MODEL` | `claude-sonnet-5-5` | the model in `create_llm` |
| `PORT` | `8787` | the port the server listens on |

## What is verified

Written and tested against `livekit-agents` 1.8.8 and `livekit-plugins-anthropic` 1.8.8.

- **Offline, in CI:** `uv run --directory examples/frameworks/livekit-agents python -m pytest -q`. Most tests replace the LLM with a fake `livekit.agents` LLM that streams scripted chunks, so `AgentSession`, its tool execution and the bridge are real. They check that two calls from one response go out as one step with their ids, that results reach the LLM and the turn ends with a reply, that a failed call reaches the LLM as an error, that an LLM error fails the step with 502, that a call id can come back in a later turn, that a message arriving while calls wait for results fails the step with 409 and the server still shuts down, and that sessions do not share history.
- **Offline, in CI:** one test keeps the real `create_llm()`, `create_session()` and Anthropic plugin, and replaces only the network client with one that streams scripted Messages API events. It checks the model, system prompt, tool schemas and `tool_result` blocks in the requests the plugin builds.
- **Offline, where Node 22.18 or later and the repository's `node_modules` are present:** the last test runs the real sandtable CLI against the server on the freight task `book-at-posted-rate`, and expects pass^1 of 100%. CI's Python job has no Node, so the test is skipped there.
- **Not verified:** a live run with a model. It needs an API key and has not been run, so there is no score for this agent yet. Nothing about audio is tested.

## Limits

- `livekit-plugins-anthropic` 1.8.8 does not keep Claude's thinking blocks in the chat context, and its model list ends at `claude-opus-4-6` (other model names are passed through). Check that your plugin version supports the model you rehearse.
- Sessions stay open until the server stops. The protocol has no end-of-session call.
- sandtable cannot see the agent's model calls, so reported tokens and cost cover only the simulated user.
- A slow model call stalls its trial, because sandtable does not time out requests.
