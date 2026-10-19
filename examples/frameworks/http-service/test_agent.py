"""Offline tests for agent.py. A scripted fake replaces the Claude client: no API key, no network.

The fake plays a careful agent on the freight example's `book-at-posted-rate` call, so the last
test can also run the real sandtable CLI against the server when Node 22.18+ and the repo's
node_modules are available.
"""

import json
import shutil
import subprocess
import threading
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import pytest
from anthropic.types.beta import BetaMessage, BetaTextBlock, BetaToolUseBlock, BetaUsage

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


def reply(stop_reason, *blocks):
    usage = BetaUsage(input_tokens=0, output_tokens=0)
    return BetaMessage(id="msg_fake", type="message", role="assistant", model="fake", content=list(blocks), stop_reason=stop_reason, stop_sequence=None, usage=usage)


def text(t):
    return BetaTextBlock(type="text", text=t)


def tool_use(id, name, **arguments):
    return BetaToolUseBlock(type="tool_use", id=id, name=name, input=arguments)


class FakeClaude:
    """Stands in for anthropic.Anthropic(): records each request and answers from a script."""

    def __init__(self):
        self.requests = []
        self.refuse = False
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self.create))

    def create(self, **request):
        self.requests.append({**request, "messages": list(request["messages"])})  # as sent, before the agent appends
        if self.refuse:
            return reply("refusal")
        last = request["messages"][-1]["content"]
        if isinstance(last, str):  # a user message
            if "MC 100101" in last:  # two calls in one step
                return reply(
                    "tool_use",
                    text("One moment."),
                    tool_use("toolu_1", "verify_carrier", mc_number="100101"),
                    tool_use("toolu_2", "search_loads", origin="Dallas", destination="Atlanta", equipment="dry_van"),
                )
            if "book it" in last:
                return reply("tool_use", tool_use("toolu_3", "book_load", load_id="L-1001", mc_number="100101", rate=2100))
            return reply("end_turn", text("Thanks for calling Acme Freight."))
        result = last[-1]  # tool_result blocks answering the previous step
        if result["is_error"]:
            return reply("end_turn", text(f"Sorry, that didn't work: {result['content']}"))
        if result["tool_use_id"] == "toolu_3":
            return reply("end_turn", text("You're booked on L-1001 at $2,100."))
        return reply("end_turn", text("You're verified. L-1001, Dallas to Atlanta, picks up November 4 and pays $2,100. Want it?"))


@pytest.fixture
def server(monkeypatch):
    fake = FakeClaude()
    monkeypatch.setattr(agent, "client", fake)
    monkeypatch.setattr(agent, "sessions", {})
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), agent.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_port}/step", fake
    httpd.shutdown()


def post(url, **step):
    body = json.dumps({"system": SYSTEM, "tools": TOOLS, **step}).encode()
    request = urllib.request.Request(url, data=body, headers={"content-type": "application/json"})
    with urllib.request.urlopen(request) as response:
        return json.load(response)


def test_tool_use_becomes_tool_calls_and_end_turn_becomes_reply(server):
    url, fake = server
    out = post(url, session_id="run/t#0", message="MC 100101, anything Dallas to Atlanta?")
    assert out == {
        "tool_calls": [
            {"id": "toolu_1", "name": "verify_carrier", "arguments": {"mc_number": "100101"}},
            {"id": "toolu_2", "name": "search_loads", "arguments": {"origin": "Dallas", "destination": "Atlanta", "equipment": "dry_van"}},
        ]
    }
    first = fake.requests[0]
    assert first["system"] == SYSTEM and first["tools"] == TOOLS
    assert first["fallbacks"] == "default"

    results = [
        {"id": "toolu_1", "ok": True, "result": {"mc_number": "100101", "name": "Blue Mesa Trucking"}},
        {"id": "toolu_2", "ok": True, "result": [{"load_id": "L-1001"}]},
    ]
    out = post(url, session_id="run/t#0", tool_results=results)
    assert out["reply"].startswith("You're verified. L-1001")

    sent = fake.requests[1]["messages"]
    assert [m["role"] for m in sent] == ["user", "assistant", "user"]
    assert sent[2]["content"] == [
        {"type": "tool_result", "tool_use_id": "toolu_1", "content": json.dumps(results[0]["result"]), "is_error": False},
        {"type": "tool_result", "tool_use_id": "toolu_2", "content": json.dumps(results[1]["result"]), "is_error": False},
    ]


def test_failed_tool_call_is_sent_back_as_an_error(server):
    url, fake = server
    assert post(url, session_id="run/t#0", message="Sounds good, book it.")["tool_calls"][0]["name"] == "book_load"
    out = post(url, session_id="run/t#0", tool_results=[{"id": "toolu_3", "ok": False, "error": "Load L-1001 is not available"}])
    assert out == {"reply": "Sorry, that didn't work: Load L-1001 is not available"}
    assert fake.requests[1]["messages"][-1]["content"][0]["is_error"] is True


def test_each_session_keeps_its_own_history(server):
    url, fake = server
    post(url, session_id="run/a#0", message="MC 100101, anything Dallas to Atlanta?")
    post(url, session_id="run/b#0", message="Hello?")
    post(url, session_id="run/a#0", tool_results=[{"id": "toolu_1", "ok": True, "result": {}}, {"id": "toolu_2", "ok": True, "result": []}])
    post(url, session_id="run/b#0", message="Anyone there?")
    assert [len(r["messages"]) for r in fake.requests] == [1, 1, 3, 3]
    assert set(agent.sessions) == {"run/a#0", "run/b#0"}


def test_refusal_becomes_a_reply_and_is_not_kept(server):
    url, fake = server
    fake.refuse = True
    assert post(url, session_id="run/t#0", message="Hi") == {"reply": "Sorry, I can't help with that."}
    assert [m["role"] for m in agent.sessions["run/t#0"]] == ["user"]


def node_can_run_sandtable():
    node = shutil.which("node")
    if node is None or not (REPO / "node_modules").is_dir():
        return False
    version = subprocess.run([node, "-p", "process.versions.node"], capture_output=True, text=True).stdout
    return tuple(int(part) for part in version.strip().split(".")[:2]) >= (22, 18)


@pytest.mark.skipif(not node_can_run_sandtable(), reason="needs Node 22.18+ and `npm ci` at the repo root")
def test_sandtable_cli_passes_a_freight_task(server, tmp_path):
    url, _ = server
    command = ["node", "src/cli.ts", "run", "examples/freight", "--agent", url, "--user", "scripted", "-t", "book-at-posted-rate", "--no-html", "--fail-under", "100", "-o", str(tmp_path)]
    run = subprocess.run(command, cwd=REPO, capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stdout + run.stderr
    assert json.loads((tmp_path / "results.json").read_text())["passHat"]["1"] == 1
