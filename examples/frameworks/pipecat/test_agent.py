"""Offline tests for agent.py: no API key, no network.

Most tests replace the bot's LLM service with FakeLLM. It pushes the same frames a real service
pushes and starts function calls through Pipecat's own run_function_calls, so the aggregators, the
function-call machinery and the bridge are all real. It plays a careful agent on the freight
example's `book-at-posted-rate` call, so the last test can also run the real sandtable CLI against
the server when Node 22.18+ and the repo's node_modules are available.

One test keeps the real create_llm() and AnthropicLLMService, and replaces only the network client.
"""

import asyncio
import copy
import dataclasses
import json
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pipecat.services.anthropic.llm
import pytest
from aiohttp.test_utils import TestClient, TestServer
from anthropic.types.beta import (
    BetaInputJSONDelta,
    BetaMessage,
    BetaMessageDeltaUsage,
    BetaRawContentBlockDeltaEvent,
    BetaRawContentBlockStartEvent,
    BetaRawContentBlockStopEvent,
    BetaRawMessageDeltaEvent,
    BetaRawMessageStartEvent,
    BetaTextBlock,
    BetaTextDelta,
    BetaToolUseBlock,
    BetaUsage,
)
from anthropic.types.beta.beta_raw_message_delta_event import Delta
from pipecat.frames.frames import FunctionCallFromLLM, LLMContextFrame, LLMFullResponseEndFrame, LLMFullResponseStartFrame, LLMTextFrame
from pipecat.services.llm_service import LLMService
from pipecat.services.settings import LLMSettings

import agent

REPO = Path(__file__).resolve().parents[3]
SYSTEM = "You answer inbound calls from carriers."
TOOLS = [
    {
        "name": "verify_carrier",
        "description": "Look up a carrier by MC number.",
        "input_schema": {"type": "object", "properties": {"mc_number": {"type": "string"}}, "required": ["mc_number"], "additionalProperties": False},
    }
]
VERIFY = ("call_1", "verify_carrier", {"mc_number": "100101"})
SEARCH = ("call_2", "search_loads", {"origin": "Dallas", "destination": "Atlanta", "equipment": "dry_van"})
BOOK = ("call_3", "book_load", {"load_id": "L-1001", "mc_number": "100101", "rate": 2100})


def script(messages):
    """The careful agent's next move, from the context: (text, [(call_id, name, arguments)])."""
    last_user = max(i for i, m in enumerate(messages) if m["role"] == "user")
    said = messages[last_user]["content"]
    results = {m["tool_call_id"]: json.loads(m["content"]) for m in messages[last_user:] if m["role"] == "tool"}
    if not results:
        if "MC 100101" in said:
            return "One moment.", [VERIFY, SEARCH]  # two calls in one response
        if "book it" in said:
            return "", [BOOK]
        if "fail" in said:
            return "FAIL", []
        return "Thanks for calling Acme Freight.", []
    errors = [r["error"] for r in results.values() if "error" in r]
    if errors:
        return f"Sorry, that didn't work: {errors[0]}", []
    if "call_3" in results:
        return "You're booked on L-1001 at $2,100.", []
    return "You're verified. L-1001, Dallas to Atlanta, picks up November 4 and pays $2,100. Want it?", []


class FakeLLM(LLMService):
    """Stands in for the bot's LLM service and records the messages each inference saw."""

    def __init__(self, step):
        super().__init__(settings=LLMSettings(**{f.name: None for f in dataclasses.fields(LLMSettings) if f.name != "extra"}))
        self.system = step["system"]
        self.seen = []

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if not isinstance(frame, LLMContextFrame):
            await self.push_frame(frame, direction)
            return
        messages = frame.context.get_messages()
        self.seen.append(copy.deepcopy(messages))
        text, calls = script(messages)
        await self.push_frame(LLMFullResponseStartFrame())
        if text == "FAIL":  # what a real service does when the API call fails
            await self.push_error("model unavailable")
            await self.push_frame(LLMFullResponseEndFrame())
            return
        if text:
            await self.push_frame(LLMTextFrame(text))
        await self.run_function_calls(
            [FunctionCallFromLLM(function_name=name, tool_call_id=call_id, arguments=args, context=frame.context) for call_id, name, args in calls]
        )
        await self.push_frame(LLMFullResponseEndFrame())


@pytest.fixture
def fakes(monkeypatch):
    """Every session gets a fresh FakeLLM; the list holds them in creation order."""
    created = []

    def create_llm(step):
        created.append(FakeLLM(step))
        return created[-1]

    monkeypatch.setattr(agent, "create_llm", create_llm)
    return created


def with_agent(scenario):
    """Run scenario(client) against the agent's app, served on a local port."""

    async def main():
        async with TestClient(TestServer(await agent.create_app())) as client:
            await asyncio.wait_for(scenario(client), timeout=30)

    asyncio.run(main())


async def post(client, **step):
    response = await client.post("/step", json={"system": SYSTEM, "tools": TOOLS, **step})
    assert response.status == 200, await response.text()
    return await response.json()


def test_function_calls_become_tool_calls_and_the_turn_ends_with_a_reply(fakes):
    async def scenario(client):
        out = await post(client, session_id="run/t#0", message="MC 100101, anything Dallas to Atlanta?")
        assert out == {"tool_calls": [{"id": i, "name": n, "arguments": a} for i, n, a in (VERIFY, SEARCH)]}

        carrier = {"mc_number": "100101", "name": "Blue Mesa Trucking"}
        results = [{"id": "call_1", "ok": True, "result": carrier}, {"id": "call_2", "ok": True, "result": [{"load_id": "L-1001"}]}]
        out = await post(client, session_id="run/t#0", tool_results=results)
        assert out == {"reply": "One moment. You're verified. L-1001, Dallas to Atlanta, picks up November 4 and pays $2,100. Want it?"}

        [llm] = fakes
        assert llm.system == SYSTEM
        tool_messages = {m["tool_call_id"]: json.loads(m["content"]) for m in llm.seen[-1] if m["role"] == "tool"}
        assert tool_messages == {"call_1": {"result": carrier}, "call_2": {"result": [{"load_id": "L-1001"}]}}

    with_agent(scenario)


def test_an_empty_result_still_runs_the_llm(fakes):
    # Pipecat skips the next inference after a falsy result. A search that finds nothing returns [].
    async def scenario(client):
        await post(client, session_id="run/t#0", message="MC 100101, anything Dallas to Atlanta?")
        results = [{"id": "call_1", "ok": True, "result": {}}, {"id": "call_2", "ok": True, "result": []}]
        assert "reply" in await post(client, session_id="run/t#0", tool_results=results)

    with_agent(scenario)


def test_a_failed_call_reaches_the_llm_as_an_error(fakes):
    async def scenario(client):
        out = await post(client, session_id="run/t#0", message="Sounds good, book it.")
        assert [c["name"] for c in out["tool_calls"]] == ["book_load"]
        out = await post(client, session_id="run/t#0", tool_results=[{"id": "call_3", "ok": False, "error": "Load L-1001 is not available"}])
        assert out == {"reply": "Sorry, that didn't work: Load L-1001 is not available"}

    with_agent(scenario)


def test_an_llm_error_fails_the_step(fakes):
    async def scenario(client):
        response = await client.post("/step", json={"session_id": "run/t#0", "system": SYSTEM, "tools": TOOLS, "message": "please fail"})
        assert response.status == 502
        assert "model unavailable" in (await response.json())["error"]

    with_agent(scenario)


def test_each_session_has_its_own_pipeline_and_history(fakes):
    async def scenario(client):
        await post(client, session_id="run/a#0", message="MC 100101, anything Dallas to Atlanta?")
        assert await post(client, session_id="run/b#0", message="Hello?") == {"reply": "Thanks for calling Acme Freight."}
        await post(client, session_id="run/a#0", tool_results=[{"id": "call_1", "ok": True, "result": {}}, {"id": "call_2", "ok": True, "result": [{"load_id": "L-1001"}]}])
        await post(client, session_id="run/b#0", message="Anyone there?")

        a, b = fakes
        assert [m["content"] for m in b.seen[-1] if m["role"] == "user"] == ["Hello?", "Anyone there?"]
        assert [m["content"] for m in a.seen[-1] if m["role"] == "user"] == ["MC 100101, anything Dallas to Atlanta?"]

    with_agent(scenario)


def stream(block, delta, stop_reason):
    """The events of one streamed Messages API response with a single content block."""
    events = [
        BetaRawMessageStartEvent.model_construct(type="message_start", message=BetaMessage.model_construct(usage=BetaUsage.model_construct(input_tokens=0, output_tokens=0))),
        BetaRawContentBlockStartEvent.model_construct(type="content_block_start", index=0, content_block=block),
        BetaRawContentBlockDeltaEvent.model_construct(type="content_block_delta", index=0, delta=delta),
        BetaRawContentBlockStopEvent.model_construct(type="content_block_stop", index=0),
        BetaRawMessageDeltaEvent.model_construct(type="message_delta", delta=Delta.model_construct(stop_reason=stop_reason), usage=BetaMessageDeltaUsage.model_construct(output_tokens=0)),
    ]

    async def iterate():
        for event in events:
            yield event

    return iterate()


class FakeAnthropic:
    """Stands in for AsyncAnthropic under the real AnthropicLLMService: records requests, streams a script."""

    def __init__(self):
        self.requests = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self.create))

    async def create(self, **params):
        self.requests.append(copy.deepcopy(params))
        if len(self.requests) == 1:
            call = BetaToolUseBlock(type="tool_use", id="toolu_1", name="verify_carrier", input={})
            return stream(call, BetaInputJSONDelta(type="input_json_delta", partial_json='{"mc_number": "100101"}'), "tool_use")
        return stream(BetaTextBlock(type="text", text=""), BetaTextDelta(type="text_delta", text="You're verified."), "end_turn")


def test_create_llm_runs_the_real_anthropic_service(monkeypatch):
    # Everything real but the network: create_llm(), AnthropicLLMService and its request conversion.
    fake = FakeAnthropic()
    monkeypatch.setattr(pipecat.services.anthropic.llm, "AsyncAnthropic", lambda **_: fake)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "not-a-real-key")
    monkeypatch.delenv("AGENT_MODEL", raising=False)

    async def scenario(client):
        out = await post(client, session_id="run/t#0", message="MC 100101 here.")
        assert out == {"tool_calls": [{"id": "toolu_1", "name": "verify_carrier", "arguments": {"mc_number": "100101"}}]}
        out = await post(client, session_id="run/t#0", tool_results=[{"id": "toolu_1", "ok": True, "result": {"name": "Blue Mesa Trucking"}}])
        assert out == {"reply": "You're verified."}

        first, second = fake.requests
        assert first["model"] == "claude-sonnet-5-5"
        assert SYSTEM in json.dumps(first["system"])
        assert [(t["name"], t["input_schema"]["properties"]) for t in first["tools"]] == [("verify_carrier", {"mc_number": {"type": "string"}})]
        [result] = [b for m in second["messages"] if isinstance(m["content"], list) for b in m["content"] if b["type"] == "tool_result"]
        assert result["tool_use_id"] == "toolu_1" and "Blue Mesa Trucking" in json.dumps(result["content"])

    with_agent(scenario)


def node_can_run_sandtable():
    node = shutil.which("node")
    if node is None or not (REPO / "node_modules").is_dir():
        return False
    version = subprocess.run([node, "-p", "process.versions.node"], capture_output=True, text=True).stdout
    return tuple(int(part) for part in version.strip().split(".")[:2]) >= (22, 18)


@pytest.mark.skipif(not node_can_run_sandtable(), reason="needs Node 22.18+ and `npm ci` at the repo root")
def test_sandtable_cli_passes_a_freight_task(fakes, tmp_path):
    async def scenario(client):
        url = str(client.make_url("/step"))
        command = ["src/cli.ts", "run", "examples/freight", "--agent", url, "--user", "scripted", "-t", "book-at-posted-rate", "--no-html", "--fail-under", "100", "-o", str(tmp_path)]
        cli = await asyncio.create_subprocess_exec("node", *command, cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        output, _ = await cli.communicate()
        assert cli.returncode == 0, output.decode()
        assert json.loads((tmp_path / "results.json").read_text())["passHat"]["1"] == 1

    with_agent(scenario)
