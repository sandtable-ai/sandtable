# Example: a Retell agent export

A fictional bike shop's phone agent, as Retell's API returns it, for `sandtable import retell`. Every name, number and URL here is made up.

| File | What it is |
|---|---|
| `agent.json` | the agent (`GET https://api.retellai.com/get-agent/<agent_id>`), whose `response_engine` names its Retell LLM |
| `llm.json` | the Retell LLM (`GET https://api.retellai.com/get-retell-llm/<llm_id>`): its prompt, its begin message, a custom function, a transfer and an end-call tool, and the default values of its dynamic variables |
| `tests/*.json` | two test cases (`GET https://api.retellai.com/get-test-case-definition/<id>`), with tool mocks |

From a clone of the repository:

```bash
npx sandtable-ai import retell examples/retell -o pinecrest
npx sandtable-ai validate pinecrest
npx sandtable-ai run pinecrest --agent noop --user scripted
```

The import is a draft: each tool, the table drafted from the test cases' tool mocks, and each task are pending review, with TODO notes on what the export can't say, such as what a function changes and how to grade a test case's metrics without a model. A mock that matches some arguments (`partial_match`) becomes an expected call with those arguments.

To grade the agent's own test calls on the drafted world, run `npx sandtable-ai serve pinecrest` behind a tunnel and set each custom function's URL to the world server's `/webhook/<tool>`, such as `https://<tunnel>/webhook/get_repair`. That route takes Retell's request with or without "Payload: args only". This folder is not part of the npm package.
