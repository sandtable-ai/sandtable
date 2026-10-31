# Example: a Vapi assistant export

A fictional bike shop's phone assistant, as Vapi's API returns it, for `sandtable import vapi`. Every name, number and URL here is made up.

| File | What it is |
|---|---|
| `assistant.json` | the assistant (`GET https://api.vapi.ai/assistant/<id>`): its system prompt, a function tool, a transfer and an end-call tool inline, and one tool by `toolIds` |
| `tools/book_service.json` | the tool `toolIds` names (`GET https://api.vapi.ai/tool/<id>`) |
| `scenarios/*.json` | two simulation scenarios (`GET https://api.vapi.ai/eval/simulation/scenario/<id>`), with tool mocks |

From a clone of the repository:

```bash
npx sandtable-ai import vapi examples/vapi -o pinecrest
npx sandtable-ai validate pinecrest
npx sandtable-ai run pinecrest --agent noop --user scripted
```

The import is a draft: each tool, the tables drafted from the scenarios' tool mocks, and each task are pending review, with TODO notes on what the export can't say, such as what a tool changes and how a scenario is graded without a model. This folder is not part of the npm package.
