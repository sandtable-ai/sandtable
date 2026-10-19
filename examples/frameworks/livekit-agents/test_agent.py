"""Offline tests for agent.py: no API key, no network.

Most tests replace the agent's LLM with FakeLLM, a livekit.agents LLM that streams scripted chunks,
so AgentSession, the tool execution and the bridge are real. It plays a careful agent on the freight
example's `book-at-posted-rate` call, so the last test can also run the real sandtable CLI against
the server when Node 22.18+ and the repo's node_modules are available.

One test keeps the real create_llm() and the Anthropic plugin, and replaces only the network client.
"""

import asyncio
import copy
import json
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import anthropic as anthropic_sdk
import pytest
from aiohttp.test_utils import TestClient, TestServer
from anthropic.types import (
    InputJSONDelta,
    Message,
    MessageDeltaUsage,
    RawContentBlockDeltaEvent,
    RawContentBlockStartEvent,
    RawContentBlockStopEvent,
    RawMessageDeltaEvent,
    RawMessageStartEvent,
    TextBlock,
    TextDelta,
    ToolUseBlock,
    Usage,
)
from anthropic.types.raw_message_delta_event import Delta
from livekit.agents import APIStatusError, llm
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS

import agent

REPO = Path(__file__).resolve().parents[3]
SYSTEM = "You answer inbound calls from carriers."


def tool(name, description, **properties):
    schema = {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}
    return {"name": name, "description": description, "input_schema": schema}


STRING, NUMBER = {"type": "string"}, {"type": "number"}
TOOLS = [  # LiveKit registers tools by name, so these are the tools the fake calls
    tool("verify_carrier", "Look up a carrier by MC number.", mc_number=STRING),
    tool("search_loads", "Search available loads.", origin=STRING, destination=STRING, equipment=STRING),
    tool("book_load", "Book a load.", load_id=STRING, mc_number=STRING, rate=NUMBER),
]
VERIFY = ("call_1", "verify_carrier", {"mc_number": "100101"})
SEARCH = ("call_2", "search_loads", {"origin": "Dallas", "destination": "Atlanta", "equipment": "dry_van"})
BOOK = ("call_3", "book_load", {"load_id": "L-1001", "mc_number": "100101", "rate": 2100})


def script(items):
    """The careful agent's next move, from the chat context: (text, [(call_id, name, arguments)])."""
    last_user = max(i for i, item in enumerate(items) if item.type == "message" and item.role == "user")
    said = items[last_user].text_content
    outputs = {item.call_id: item for item in items[last_user:] if item.type == "function_call_output"}
    if not outputs:
        if "MC 100101" in said:
            return "One moment.", [VERIFY, SEARCH]  # two calls in one response
        if "book it" in said:
            return "", [BOOK]
        if "fail" in said:
            return "FAIL", []
        return "Thanks for calling Acme Freight.", []
    errors = [o.output for o in outputs.values() if o.is_error]
    if errors:
        return f"Sorry, that didn't work: {errors[0]}", []
    if "call_3" in outputs:
        return "You're booked on L-1001 at $2,100.", []
    return "You're verified. L-1001, Dallas to Atlanta, picks up November 4 and pays $2,100. Want it?", []


class FakeStream(llm.LLMStream):
    async def _run(self):
        self._llm.seen.append(list(self._chat_ctx.items))
        text, calls = script(self._chat_ctx.items)
        if text == "FAIL":  # what a provider plugin raises when the API call fails
            raise APIStatusError("model unavailable", status_code=500, retryable=False)
        if text:
            self._event_ch.send_nowait(llm.ChatChunk(id="fake", delta=llm.ChoiceDelta(role="assistant", content=text)))
        for call_id, name, args in calls:  # one chunk per call, as the provider plugins stream them
            call = llm.FunctionToolCall(call_id=call_id, name=name, arguments=json.dumps(args))
            self._event_ch.send_nowait(llm.ChatChunk(id="fake", delta=llm.ChoiceDelta(role="assistant", tool_calls=[call])))


class FakeLLM(llm.LLM):
    """Stands in for the agent's LLM and records the chat context of each request."""

    def __init__(self):
        super().__init__()
        self.seen = []

    def chat(self, *, chat_ctx, tools=None, conn_options=DEFAULT_API_CONNECT_OPTIONS, **_):
        return FakeStream(self, chat_ctx=chat_ctx, tools=tools or [], conn_options=conn_options)


@pytest.fixture
def fakes(monkeypatch):
    """Every session gets a fresh FakeLLM; the list holds them in creation order."""
    created = []

    def create_llm():
        created.append(FakeLLM())
        return created[-1]

    monkeypatch.setattr(agent, "create_llm", create_llm)
    return created


def with_agent(scenario):
    """Run scenario(client) against the agent's app, served on a local port. Shutdown counts toward the timeout."""

    async def main():
        async with TestClient(TestServer(agent.create_app())) as client:
            await scenario(client)

    asyncio.run(asyncio.wait_for(main(), timeout=30))


async def post(client, **step):
    response = await client.post("/step", json={"system": SYSTEM, "tools": TOOLS, **step})
    assert response.status == 200, await response.text()
    return await response.json()


def test_tool_calls_go_out_as_one_step_and_the_turn_ends_with_a_reply(fakes):
    async def scenario(client):
        out = await post(client, session_id="run/t#0", message="MC 100101, anything Dallas to Atlanta?")
        assert out == {"tool_calls": [{"id": i, "name": n, "arguments": a} for i, n, a in (VERIFY, SEARCH)]}

        carrier = {"mc_number": "100101", "name": "Blue Mesa Trucking"}
        results = [{"id": "call_1", "ok": True, "result": carrier}, {"id": "call_2", "ok": True, "result": []}]
        out = await post(client, session_id="run/t#0", tool_results=results)
        assert out == {"reply": "One moment. You're verified. L-1001, Dallas to Atlanta, picks up November 4 and pays $2,100. Want it?"}

        [fake] = fakes
        first, second = fake.seen
        assert first[0].role == "system" and first[0].text_content == SYSTEM
        outputs = {item.call_id: json.loads(item.output) for item in second if item.type == "function_call_output"}
        assert outputs == {"call_1": carrier, "call_2": []}

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
        assert response.status == 502, await response.text()
        assert "model unavailable" in (await response.json())["error"]

    with_agent(scenario)


def test_a_call_id_can_come_back_in_a_later_turn(fakes):
    # The fake gives book_load the id call_3 every time, as some models reuse ids across turns.
    async def scenario(client):
        for expected in ("You're booked on L-1001 at $2,100.", "Sorry, that didn't work: Load L-1001 is not available"):
            assert (await post(client, session_id="run/t#0", message="Sounds good, book it."))["tool_calls"][0]["id"] == "call_3"
            ok = expected.startswith("You're")
            result = {"id": "call_3", "ok": ok, **({"result": {"booking_id": "B-1"}} if ok else {"error": "Load L-1001 is not available"})}
            assert await post(client, session_id="run/t#0", tool_results=[result]) == {"reply": expected}

    with_agent(scenario)


def test_a_message_while_calls_wait_for_results_fails_the_step(fakes):
    # What happens when a turn uses up sandtable's step budget: the next message arrives instead of results.
    async def scenario(client):
        await post(client, session_id="run/t#0", message="MC 100101, anything Dallas to Atlanta?")
        response = await client.post("/step", json={"session_id": "run/t#0", "system": SYSTEM, "tools": TOOLS, "message": "Hello?"})
        assert response.status == 409
        assert (await response.json())["error"] == "tool calls ['call_1', 'call_2'] are still waiting for results"

    with_agent(scenario)


def test_each_session_has_its_own_agent_session_and_history(fakes):
    async def scenario(client):
        await post(client, session_id="run/a#0", message="MC 100101, anything Dallas to Atlanta?")
        assert await post(client, session_id="run/b#0", message="Hello?") == {"reply": "Thanks for calling Acme Freight."}
        await post(client, session_id="run/a#0", tool_results=[{"id": "call_1", "ok": True, "result": {}}, {"id": "call_2", "ok": True, "result": []}])
        await post(client, session_id="run/b#0", message="Anyone there?")

        a, b = fakes
        assert [i.text_content for i in b.seen[-1] if i.type == "message" and i.role == "user"] == ["Hello?", "Anyone there?"]
        assert [i.text_content for i in a.seen[-1] if i.type == "message" and i.role == "user"] == ["MC 100101, anything Dallas to Atlanta?"]

    with_agent(scenario)


def events(block, delta, stop_reason):
    """The events of one streamed Messages API response with a single content block."""
    return [
        RawMessageStartEvent.model_construct(type="message_start", message=Message.model_construct(id="msg_fake", usage=Usage.model_construct(input_tokens=0, output_tokens=0))),
        RawContentBlockStartEvent.model_construct(type="content_block_start", index=0, content_block=block),
        RawContentBlockDeltaEvent.model_construct(type="content_block_delta", index=0, delta=delta),
        RawContentBlockStopEvent.model_construct(type="content_block_stop", index=0),
        RawMessageDeltaEvent.model_construct(type="message_delta", delta=Delta.model_construct(stop_reason=stop_reason), usage=MessageDeltaUsage.model_construct(output_tokens=0)),
    ]


class FakeAnthropicStream:
    def __init__(self, events):
        self._events = events

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    async def __aiter__(self):
        for event in self._events:
            yield event


class FakeAnthropic:
    """Stands in for anthropic.AsyncClient under the real plugin: records requests, streams a script."""

    def __init__(self):
        self.requests = []
        self.messages = SimpleNamespace(create=self.create)
        self.beta = SimpleNamespace(messages=self.messages)
        self._base_url = SimpleNamespace(netloc=b"api.anthropic.com")  # the plugin reports it as the provider

    async def create(self, **params):
        self.requests.append(copy.deepcopy({k: v for k, v in params.items() if k != "timeout"}))
        if len(self.requests) == 1:
            call = ToolUseBlock(type="tool_use", id="toolu_1", name="verify_carrier", input={})
            return FakeAnthropicStream(events(call, InputJSONDelta(type="input_json_delta", partial_json='{"mc_number": "100101"}'), "tool_use"))
        return FakeAnthropicStream(events(TextBlock(type="text", text=""), TextDelta(type="text_delta", text="You're verified."), "end_turn"))


def test_create_llm_runs_the_real_anthropic_plugin(monkeypatch):
    # Everything real but the network: create_llm(), create_session() and the plugin's request conversion.
    fake = FakeAnthropic()
    monkeypatch.setattr(anthropic_sdk, "AsyncClient", lambda **_: fake)
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
        assert [t["name"] for t in first["tools"]] == ["verify_carrier", "search_loads", "book_load"]
        assert first["tools"][0]["input_schema"]["properties"] == {"mc_number": {"type": "string"}}
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
