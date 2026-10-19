"""Rehearse a Pipecat voice bot's LLM and tools with sandtable, as text, over the HTTP step protocol.

A voice bot runs: transport -> STT -> user aggregator -> LLM -> TTS -> transport -> assistant aggregator.
For each sandtable session this server runs the text part of that pipeline, with the bot's own LLM
service, system prompt and function schemas:

    user aggregator -> LLM -> StepBridge (where TTS would be) -> assistant aggregator

Pipecat runs function calls itself, so control is inverted here. Every function call goes to one
handler that waits for sandtable to run it. StepBridge answers the pending HTTP request with the calls
from one LLM response, or with the reply once a response ends without calls. The next request's
tool_results complete the waiting handlers, and Pipecat runs the LLM again, as it would after real tools.

    ANTHROPIC_API_KEY=... python agent.py    # serves http://127.0.0.1:8787/step
"""

import asyncio
import os

from aiohttp import web
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.frames.frames import FunctionCallsStartedFrame, LLMFullResponseEndFrame, LLMMessagesAppendFrame, LLMTextFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.anthropic.llm import AnthropicLLMService
from pipecat.services.llm_service import FunctionCallParams, LLMService
from pipecat.turns.user_turn_strategies import ExternalUserTurnStrategies
from pipecat.workers.runner import WorkerRunner

PORT = int(os.environ.get("PORT", "8787"))


# Your bot's config: use the same LLM service, system prompt and function schemas as the voice bot.


def create_llm(step: dict) -> LLMService:
    """The bot's LLM service. step["system"] is sandtable's prompt (the domain's description and
    policy): put your bot's own system instruction here instead."""
    model = os.environ.get("AGENT_MODEL", "claude-sonnet-5-5")
    settings = AnthropicLLMService.Settings(model=model, system_instruction=step["system"])
    return AnthropicLLMService(api_key=os.environ["ANTHROPIC_API_KEY"], settings=settings)


def bot_functions(step: dict) -> list[FunctionSchema]:
    """The bot's function schemas, without handlers. Their names and arguments must match the
    domain's tools, because sandtable runs every call against its simulated world."""
    return [
        FunctionSchema(t["name"], t["description"], t["input_schema"].get("properties", {}), t["input_schema"].get("required", []))
        for t in step["tools"]
    ]


# The bridge between Pipecat and the step protocol.


class StepBridge(FrameProcessor):
    """Turns the LLM's output frames into step responses: tool calls, or the reply that ends the turn."""

    def __init__(self, outbox: asyncio.Queue):
        super().__init__()
        self._outbox = outbox
        self._text: list[str] = []  # text of the current LLM response
        self._said: list[str] = []  # every response's text this turn: what a caller would hear
        self._calls: list[dict] = []  # function calls of the current LLM response

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMTextFrame):
            self._text.append(frame.text)
        elif isinstance(frame, FunctionCallsStartedFrame) and direction == FrameDirection.DOWNSTREAM:
            # A system frame, so it is handled before the LLMFullResponseEndFrame the LLM pushes after it.
            self._calls += [{"id": c.tool_call_id, "name": c.function_name, "arguments": dict(c.arguments)} for c in frame.function_calls]
        elif isinstance(frame, LLMFullResponseEndFrame):
            self._said.append("".join(self._text).strip())
            if self._calls:
                self._outbox.put_nowait({"tool_calls": self._calls})
            else:
                self._outbox.put_nowait({"reply": " ".join(s for s in self._said if s)})
                self._said = []
            self._text, self._calls = [], []
        await self.push_frame(frame, direction)


class Session:
    """One sandtable trial: its text pipeline, the step responses it produces, and calls waiting on sandtable."""

    def __init__(self, step: dict):
        self.outbox: asyncio.Queue[dict] = asyncio.Queue()
        self.results: dict[str, asyncio.Future] = {}  # tool_call_id -> what sandtable returned
        self.unanswered: list[str] = []  # ids of the tool calls in the last response sent
        llm = create_llm(step)
        llm.register_function(None, self.run_in_sandtable)  # catch-all: every function call goes to sandtable
        # User turns arrive whole, as text, so no audio turn detection (its default loads a model per session).
        text_turns = LLMUserAggregatorParams(user_turn_strategies=ExternalUserTurnStrategies())
        user, assistant = LLMContextAggregatorPair(LLMContext(tools=bot_functions(step)), user_params=text_turns)
        self.worker = PipelineWorker(
            Pipeline([user, llm, StepBridge(self.outbox), assistant]),
            enable_rtvi=False,
            idle_timeout_frames=(LLMFullResponseEndFrame,),  # a session ends 5 minutes after its last LLM response
            cancel_runner_on_idle_timeout=False,
        )

        @llm.event_handler("on_error")  # runs before the LLM ends its response, so it answers first
        async def on_llm_error(llm, error):
            self.outbox.put_nowait({"error": error.error})

    def result(self, call_id: str) -> asyncio.Future:
        return self.results.setdefault(call_id, asyncio.get_running_loop().create_future())

    async def run_in_sandtable(self, params: FunctionCallParams):
        result = await self.result(params.tool_call_id)
        del self.results[params.tool_call_id]  # some models reuse call ids in later turns
        await params.result_callback(result)


async def create_app() -> web.Application:
    runner = WorkerRunner(handle_sigint=False)  # hosts every session's pipeline
    sessions: dict[str, Session] = {}

    async def step(request: web.Request) -> web.Response:
        body = await request.json()
        session_id = body["session_id"]
        session = sessions.get(session_id)
        if session is None:
            session = sessions[session_id] = Session(body)
            session.worker.add_event_handler("on_pipeline_finished", lambda *_: sessions.pop(session_id, None))
            await runner.add_workers(session.worker)
        if "message" in body and session.unanswered:
            # sandtable stops sending results when a turn uses up its step budget; this turn can't resume.
            error = f"tool calls {session.unanswered} are still waiting for results"
            return web.json_response({"error": error}, status=409)
        if "message" in body:
            frame = LLMMessagesAppendFrame(messages=[{"role": "user", "content": body["message"]}], run_llm=True)
            await session.worker.queue_frame(frame)
        else:
            # Pipecat runs the LLM again only after a truthy result, and a search that finds nothing
            # returns [], so the result is always wrapped.
            for r in body["tool_results"]:
                session.result(r["id"]).set_result({"result": r.get("result")} if r["ok"] else {"error": r.get("error")})
        out = await session.outbox.get()
        session.unanswered = [call["id"] for call in out.get("tool_calls", [])]
        return web.json_response(out, status=502 if "error" in out else 200)

    async def run_workers(app: web.Application):
        task = asyncio.create_task(runner.run(auto_end=False))
        yield
        await runner.cancel()
        await task

    app = web.Application()
    app.router.add_post("/step", step)
    app.cleanup_ctx.append(run_workers)
    return app


if __name__ == "__main__":
    web.run_app(create_app(), host="127.0.0.1", port=PORT)
