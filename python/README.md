# sandtable (Python launcher)

`sandtable` rehearses AI agents on a sand table of your customer's world before they go live: tau-bench-style simulations, policy invariants checked on every tool call, deterministic grading, pass^k and a CI gate.

This package installs the `sandtable` command and runs the matching release of the CLI, which is written in TypeScript and published on npm:

```bash
uvx sandtable-ai demo
# or
pip install sandtable-ai && sandtable demo
```

It needs Python 3.9 or later and Node.js 20 or later with npm. The first run downloads that CLI release from npm through `npx`; later runs use npm's cache, also offline.

Docs: https://sandtable.dev · Source: https://github.com/sandtable-ai/sandtable
