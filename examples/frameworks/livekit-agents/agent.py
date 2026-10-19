"""Rehearse a LiveKit Agents voice agent's LLM and tools with sandtable, as text, over the HTTP step protocol.

LiveKit Agents can run an AgentSession on text alone, with no room, audio, STT or TTS:
session.run(user_input=...) runs one turn through the agent's LLM and tools. For each sandtable session
this server keeps one AgentSession with the agent's own LLM and instructions, and function tools built
from the JSON-schema tools sandtable sends.

LiveKit runs tools itself, so control is inverted here. Each tool waits for sandtable to run its call.
When the model's response stream ends, the calls it made go back to sandtable as one step. The next
request's tool_results complete the waiting tools, LiveKit runs the LLM again, and when the turn ends,
what the agent said goes back as the reply.

    ANTHROPIC_API_KEY=... python agent.py    # serves http://127.0.0.1:8787/step
"""

import asyncio
import json
import os

from aiohttp import web
from livekit.agents import Agent, AgentSession, RunContext, ToolError, function_tool, llm
from livekit.plugins import anthropic

PORT = int(os.environ.get("PORT", "8787"))


# Your agent's config: use the same LLM, instructions and session settings as the voice agent.


def create_llm() -> llm.LLM:
    return anthropic.LLM(model=os.environ.get("AGENT_MODEL", "claude-sonnet-5-5"))


def instructions(step: dict) -> str:
    """step["system"] is sandtable's prompt (the domain's description and policy): return your agent's own."""
    return step["system"]


def create_session() -> AgentSession:
    """Your AgentSession settings, minus audio: no STT, TTS, VAD or turn detection."""
    return AgentSession(llm=create_llm(), vad=None, turn_handling={"turn_detection": None})


# The bridge between LiveKit Agents and the step protocol.


class Session:
    """One sandtable trial: its AgentSession, the step responses it produces, and calls waiting on sandtable."""

    def __init__(self):
        self.outbox: asyncio.Queue[dict] = asyncio.Queue()
        self.results: dict[str, asyncio.Future] = {}  # call_id -> sandtable's tool result
        self.unanswered: list[str] = []  # ids of the tool calls in the last response sent
        self.agent_session = create_session()
        self.turn: asyncio.Task | None = None

    def result(self, call_id: str) -> asyncio.Future:
        return self.results.setdefault(call_id, asyncio.get_running_loop().create_future())

    def tool(self, spec: dict) -> llm.RawFunctionTool:
        """A function tool with the domain tool's JSON schema, which waits for sandtable to run the call."""

        async def run_in_sandtable(raw_arguments: dict[str, object], context: RunContext):
            out = await self.result(context.function_call.call_id)
            del self.results[context.function_call.call_id]  # some models reuse call ids in later turns
            if not out["ok"]:
                raise ToolError(out.get("error") or "the tool call failed")
            return json.dumps(out.get("result"))

        schema = {"name": spec["name"], "description": spec["description"], "parameters": spec["input_schema"]}
        return function_tool(run_in_sandtable, raw_schema=schema)

    async def run_turn(self, message: str):
        try:
            result = await self.agent_session.run(user_input=message)
        except Exception as e:
            self.outbox.put_nowait({"error": f"{type(e).__name__}: {e}"})
            return
        said = [e.item.text_content for e in result.events if e.type == "message" and e.item.role == "assistant"]
        self.outbox.put_nowait({"reply": " ".join(s for s in said if s)})


class RehearsalAgent(Agent):
    """The voice agent with its tools wired to sandtable. If your agent overrides llm_node, start from it."""

    def __init__(self, step: dict, session: Session):
        super().__init__(instructions=instructions(step), tools=[session.tool(t) for t in step["tools"]])
        self._session = session

    async def llm_node(self, chat_ctx, tools, model_settings):
        calls: list[llm.FunctionToolCall] = []
        async for chunk in Agent.default.llm_node(self, chat_ctx, tools, model_settings):
            if isinstance(chunk, llm.ChatChunk) and chunk.delta:
                calls += chunk.delta.tool_calls
            yield chunk
        if calls:  # the response is complete, so these are all the calls of this step
            tool_calls = [{"id": c.call_id, "name": c.name, "arguments": json.loads(c.arguments or "{}")} for c in calls]
            self._session.outbox.put_nowait({"tool_calls": tool_calls})


def create_app() -> web.Application:
    sessions: dict[str, Session] = {}

    async def step(request: web.Request) -> web.Response:
        body = await request.json()
        session = sessions.get(body["session_id"])
        if session is None:
            session = sessions[body["session_id"]] = Session()
            await session.agent_session.start(RehearsalAgent(body, session))
        if "message" in body and session.unanswered:
            # sandtable stops sending results when a turn uses up its step budget; this turn can't resume.
            error = f"tool calls {session.unanswered} are still waiting for results"
            return web.json_response({"error": error}, status=409)
        if "message" in body:
            session.turn = asyncio.create_task(session.run_turn(body["message"]))
        else:
            for r in body["tool_results"]:
                session.result(r["id"]).set_result(r)
        out = await session.outbox.get()
        session.unanswered = [call["id"] for call in out.get("tool_calls", [])]
        return web.json_response(out, status=502 if "error" in out else 200)

    async def close_sessions(app: web.Application):
        for session in sessions.values():
            if session.turn is None or session.turn.done():  # a turn still waiting for results would never close
                await session.agent_session.aclose()

    app = web.Application()
    app.router.add_post("/step", step)
    app.on_cleanup.append(close_sessions)
    return app


if __name__ == "__main__":
    web.run_app(create_app(), host="127.0.0.1", port=PORT)
