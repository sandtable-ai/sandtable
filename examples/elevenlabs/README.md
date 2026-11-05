# Example: an ElevenLabs agents-as-code project

A fictional bike shop's phone agent, as the ElevenLabs CLI pulls it into a project (`elevenlabs agents pull`, `elevenlabs tools pull`, `elevenlabs tests pull`), for `sandtable import elevenlabs`. Every name, number and URL here is made up.

| File | What it is |
|---|---|
| `agents.json` | the project's agents, by id, with the config file of each |
| `agent_configs/Pinecrest-Bike-Repair.json` | the agent: its prompt, its first message, the tools its `tool_ids` name, the built-in `end_call` tool, a dynamic variable's default and the tests attached to it |
| `tools.json`, `tool_configs/*.json` | two webhook tools: `get_repair`, a GET with a path parameter, and `book_service`, a POST with a body, one of whose fields comes from a dynamic variable |
| `tests.json`, `test_configs/*.json` | a simulation test, with a tool mock, and a tool test that checks the agent calls `get_repair` with the ticket the caller gives |

From a clone of the repository:

```bash
npx sandtable-ai import elevenlabs examples/elevenlabs -o pinecrest
npx sandtable-ai validate pinecrest
npx sandtable-ai run pinecrest --agent noop --user scripted
```

The import is a draft: each tool and each task are pending review, with TODO notes on what the export can't say, such as what a tool changes, and a test's success conditions are pending `judged` criteria, which change no verdict. Each webhook tool gets its URL's path as its `http` route, such as `GET /api/repairs/{ticket_id}`.

To grade the agent's own test calls on the drafted world, run `npx sandtable-ai serve pinecrest` behind a tunnel and point each webhook tool's URL at it, keeping the path: `https://<tunnel>/api/repairs/{ticket_id}`. Add the header `X-Sandtable-Call: {{system__conversation_id}}` to each webhook tool too, so concurrent test calls each get their own world. This folder is not part of the npm package.
