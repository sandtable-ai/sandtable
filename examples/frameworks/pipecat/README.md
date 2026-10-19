# Pipecat

Rehearse a [Pipecat](https://github.com/pipecat-ai/pipecat) voice bot with sandtable. This server runs the bot's LLM layer as text: the same LLM service, system prompt and function schemas the bot uses, with no speech-to-text, text-to-speech or transport. It speaks sandtable's [HTTP step protocol](https://sandtable.dev/reference/http-protocol).

**What this rehearses:** the bot's decisions and tool use, as text. Which tools it calls, with which arguments, what it tells the caller, and whether it follows the policy. **What it does not:** audio, speech recognition, text-to-speech, turn-taking, interruptions or latency. Test those with your voice stack.

| File | What it is |
|---|---|
| `agent.py` | The bridge and its HTTP server, in one file. Your bot's config goes at the top |
| `test_agent.py` | Offline tests, with a fake LLM service and a fake Anthropic client |
| `pyproject.toml` | Dependencies, managed by [uv](https://docs.astral.sh/uv/) |

## How it works

The step protocol inverts control: sandtable runs the tools, and Pipecat expects to run them itself. The server bridges the two.

- Each sandtable session gets its own pipeline: `user aggregator → LLM → StepBridge → assistant aggregator`. `StepBridge` sits where the TTS service sits in the voice pipeline.
- A user message goes into the context with `LLMMessagesAppendFrame(run_llm=True)`.
- Every function call goes to one catch-all handler (`register_function(None, ...)`), which waits for sandtable to run the call.
- `StepBridge` answers the pending request. The calls from one LLM response go back as one `tool_calls` step. When a response ends without calls, everything the bot said this turn goes back as the `reply`.
- The next request's `tool_results` complete the waiting handlers. Pipecat adds the results to the context and runs the LLM again, as it would after the bot's real tools.

A few details matter:

- Results reach the LLM as `{"result": ...}` or `{"error": ...}`. Pipecat runs the LLM again only after a truthy result, and a search that finds nothing returns `[]`, which would stall the turn.
- User turns arrive whole, as text, so the user aggregator uses `ExternalUserTurnStrategies`. The default strategy loads a turn-detection model for every session.
- If the LLM service reports an error, the step fails with status 502, and sandtable ends the trial as a runtime failure.
- A session's pipeline ends 5 minutes after its last LLM response, through Pipecat's idle timeout. The protocol has no end-of-session call.

## Plug in your bot

Edit the two functions at the top of `agent.py`:

- `create_llm(step)` returns the LLM service your bot uses, with its system instruction. The example uses `AnthropicLLMService` on `claude-sonnet-5-5`, with the prompt sandtable sends (the domain's description and policy). Put your bot's own prompt there.
- `bot_functions(step)` returns your bot's `FunctionSchema` list, without handlers. The names and arguments must match the domain's tools, because sandtable runs every call against its simulated world. The example builds them from the tools sandtable sends.

Your bot's real function handlers do not run here. That is the point: nothing reaches a real system.

## Run it live

You need an Anthropic API key, or the key for the service `create_llm` returns. Every trial calls the model, so a run costs money.

```bash
cd examples/frameworks/pipecat
export ANTHROPIC_API_KEY=...
uv run python agent.py        # serves http://127.0.0.1:8787/step
```

In a second terminal, from the repository root:

```bash
npx sandtable-ai run examples/freight --agent http://localhost:8787/step --user scripted
```

Until `sandtable-ai` is published on npm, run the same command from a clone of this repository with `npm run sandtable -- run examples/freight --agent http://localhost:8787/step --user scripted`.

`--user scripted` replays each task's scripted caller lines, so only the bot calls a model. For a caller that adapts to what the bot says, use Claude as the simulated user, for example `--user claude:claude-haiku-5-5`. Add `-k 4` for pass^4.

| Variable | Default | What it sets |
|---|---|---|
| `AGENT_MODEL` | `claude-sonnet-5-5` | the model in `create_llm` |
| `PORT` | `8787` | the port the server listens on |

## What is verified

Written and tested against `pipecat-ai` 1.13.0.

- **Offline, in CI:** `uv run --directory examples/frameworks/pipecat python -m pytest -q`. Most tests replace the LLM service with a fake that pushes the same frames a real service pushes and starts calls through Pipecat's own `run_function_calls`, so the aggregators, the function-call machinery and the bridge are real. They check that two calls from one response come back as one step with their ids, that results reach the LLM and the turn ends with a reply, that an empty result still runs the LLM, that a failed call reaches the LLM as an error, that an LLM error fails the step with 502, and that sessions do not share history.
- **Offline, in CI:** one test keeps the real `create_llm()` and `AnthropicLLMService` and replaces only the network client, with one that streams scripted Messages API events. It checks the model, system prompt, tool schemas and `tool_result` blocks in the requests Pipecat builds.
- **Offline, where Node 22.18 or later and the repository's `node_modules` are present:** the last test runs the real sandtable CLI against the server on the freight task `book-at-posted-rate`, and expects pass^1 of 100%. CI's Python job has no Node, so the test is skipped there.
- **Not verified:** a live run with a model. It needs an API key and has not been run, so there is no score for this bot yet. Nothing about audio is tested.

## Limits

- sandtable cannot see the bot's model calls, so reported tokens and cost cover only the simulated user.
- A slow model call stalls its trial, because sandtable does not time out requests.
