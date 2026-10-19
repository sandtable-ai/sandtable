"""A plain Python HTTP agent on the Claude Messages API, served over sandtable's HTTP step protocol.

The protocol maps directly onto the Messages API, so there is no bridge:

    request "message"        -> a user turn
    model tool_use blocks    -> response "tool_calls" (the tool_use id is the call id)
    request "tool_results"   -> tool_result blocks
    model end_turn text      -> response "reply"

The conversation is kept in memory, one history per session_id.

    ANTHROPIC_API_KEY=... python agent.py    # serves http://127.0.0.1:8787/step
"""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import anthropic

MODEL = os.environ.get("AGENT_MODEL", "claude-sonnet-5-5")
PORT = int(os.environ.get("PORT", "8787"))

# Your agent's own system prompt. None uses the one sandtable sends: the domain description and policy.
SYSTEM_PROMPT = None

client = anthropic.Anthropic()
sessions: dict[str, list] = {}  # session_id -> Messages API history


def tool_result_block(result: dict) -> dict:
    if result["ok"]:
        content = json.dumps(result.get("result"))
    else:
        content = result.get("error") or "the tool call failed"
    return {"type": "tool_result", "tool_use_id": result["id"], "content": content, "is_error": not result["ok"]}


def step(body: dict) -> dict:
    """Answer one protocol step: a new user message, or the results of the previous tool calls."""
    messages = sessions.setdefault(body["session_id"], [])
    if "message" in body:
        messages.append({"role": "user", "content": body["message"]})
    else:
        messages.append({"role": "user", "content": [tool_result_block(r) for r in body["tool_results"]]})

    response = client.beta.messages.create(
        model=MODEL,
        max_tokens=16000,
        system=SYSTEM_PROMPT or body["system"],
        tools=body["tools"],  # already in Messages API shape: name, description, input_schema
        messages=messages,
        # If the model declines for policy reasons, retry server-side on Anthropic's recommended fallback.
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )
    if response.stop_reason == "refusal":
        return {"reply": "Sorry, I can't help with that."}

    # Keep the whole content, thinking blocks included: the next request must send them back unchanged.
    messages.append({"role": "assistant", "content": response.content})
    calls = [block for block in response.content if block.type == "tool_use"]
    if calls:
        return {"tool_calls": [{"id": c.id, "name": c.name, "arguments": c.input} for c in calls]}
    return {"reply": "".join(block.text for block in response.content if block.type == "text")}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        try:
            status, out = 200, step(body)
        except anthropic.APIError as e:
            # The SDK has already retried rate limits, 5xx and connection errors. sandtable shows
            # this status and body, and ends the trial as a runtime failure.
            status, out = 502, {"error": f"{type(e).__name__}: {e}"}
        data = json.dumps(out).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    print(f"agent ({MODEL}) listening on http://127.0.0.1:{PORT}/step")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
