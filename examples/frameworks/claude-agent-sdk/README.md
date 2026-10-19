# Rehearse a Claude Agent SDK agent

`agent.ts` is a [module agent](https://sandtable.dev/guides/bring-your-agent#your-agent-as-a-js-or-ts-module) for an agent built with the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) (`@anthropic-ai/claude-agent-sdk`). It wraps a `query()` in sandtable's `AgentAdapter`:

- sandtable calls the default export with no options and opens one session per trial. Each session is one `query()` in streaming input mode, so the SDK keeps the conversation. Each user turn goes into the query's input stream, and the adapter returns the text of that turn's `result` message.
- The domain's tools are served by an in-process MCP server (`createSdkMcpServer`). Each handler calls sandtable's `callTool`, so the call runs against the trial's simulated world, is checked against the domain's invariants and is graded. Nothing reaches a real system. A failed call comes back to Claude with `isError: true`.
- Claude Code's built-in tools are off (`tools: []`): no Bash, no file tools, no web, no subagents. `allowedTools` admits only `mcp__sandtable__*`, and `permissionMode: "dontAsk"` denies anything else.
- The session ignores the machine's Claude Code setup: `settingSources: []` skips user and project settings, `CLAUDE.md` and hooks, `strictMcpConfig` skips other MCP servers, and `persistSession: false` keeps transcripts off disk.
- Each turn's token usage goes to `recordUsage`, so the report shows tokens and cost.

To rehearse your own agent, pass your own `systemPrompt` instead of sandtable's default prompt. If your agent already has an SDK MCP server, keep its tool names and schemas (the domain's tools mirror them) and swap each handler's body for `callTool`.

Two differences from sandtable's other adapters:

- Claude sees each tool as `mcp__sandtable__<name>`, for example `mcp__sandtable__verify_carrier`.
- The MCP layer validates arguments against each tool's schema (converted to Zod) before sandtable sees them, as it would in production. A call it rejects goes back to Claude as an error and is not in sandtable's tool log, and arguments the schema doesn't list are dropped.

## Run it

From the repository root:

```bash
npm ci && npm run build                      # the example imports sandtable-ai's types from dist/
(cd examples/frameworks/claude-agent-sdk && npm ci)
export ANTHROPIC_API_KEY=...                 # the agent, and Claude as the default simulated caller
npm run sandtable -- run examples/freight --agent examples/frameworks/claude-agent-sdk/agent.ts -k 4
```

The model is `ANTHROPIC_MODEL`, default `claude-opus-5-5`. Add `--user scripted` to replay each task's script instead of a Claude caller. Each trial runs its own Claude Code process, which the SDK installs as a platform-specific package. Running a `.ts` agent needs Node 22.18 or later.

## Check it offline

```bash
cd examples/frameworks/claude-agent-sdk
npm run check
```

No model calls, no API key, and no Claude Code process. The SDK runs its agent loop inside the Claude Code process it spawns, and that loop needs a model, so this check covers only the parts that run without one:

- it typechecks `agent.ts` against the SDK's and sandtable's types
- it imports the module and checks that the default export builds an adapter
- it connects an MCP client to the adapter's in-process server and asserts that the server lists the domain's tools with their required parameters, that `verify_carrier` and `book_load` run in sandtable's simulated world (the booking row is written), and that a refused call comes back with `isError` and the world's error message

Not checked: the `query()` loop, the per-session conversation, the settings that turn off built-in tools, and usage reporting. They need a model, and a live run needs API keys and has not been run.

## Use it in your project

Until the first release, `package.json` depends on this repository with `"sandtable-ai": "file:../../.."`, and the types come from the root's `dist/`, so run `npm run build` at the root first. After the first release, replace it with `"sandtable-ai": "^0.1.0"`, copy `agent.ts` next to your agent, and run `npx sandtable-ai run ./my-domain --agent ./agent.ts`.

Built against `@anthropic-ai/claude-agent-sdk` 0.3.303.
