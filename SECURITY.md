# Security policy

## Reporting a vulnerability

Please don't open a public issue. Report it privately on GitHub instead: [report a vulnerability](https://github.com/sandtable-ai/sandtable/security/advisories/new). You should hear back within a week.

Say which version you ran (`npx sandtable-ai --version`), the command, and the smallest domain that shows the problem. Use fictional data, and never include a real API key.

## Supported versions

Fixes go into the latest release of `sandtable-ai` on npm and PyPI. Before 1.0, only the newest minor version gets them.

## Scope

sandtable runs on your machine. It calls the model providers and agent endpoints you configure, and writes results and an HTML report that show what the models said. Reports we especially want:

- an API key, AWS credential or other secret that ends up in `results.json`, `run.json`, a report, the terminal output or an error message
- a domain file, an agent reply or a model's output that makes sandtable read or write files outside its run folder, run a command, or send data somewhere you didn't configure
- script in a transcript, tool result or domain file that runs when you open an HTML report
- personal data that `init --transcripts` sends to a model even though it should have been scrubbed locally first

Not in scope: an agent or a simulated caller misbehaving inside a simulation, which is what sandtable measures, and the behaviour of the model providers themselves.
