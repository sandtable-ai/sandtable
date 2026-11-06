# sandtable (Python launcher)

`sandtable` rehearses AI agents on a sand table of your customer's world before they go live: tau-bench-style simulations, policy invariants checked on every tool call, deterministic grading, pass^k and a CI gate.

This package installs the `sandtable` command and runs the matching release of the CLI, which is written in TypeScript and published on npm:

```bash
uvx sandtable-ai demo
# or
pip install sandtable-ai && sandtable demo
```

It needs Python 3.10 or later and Node.js 22 or later with npm. The first run downloads that CLI release from npm through `npx`; later runs use npm's cache, also offline.

`uvx sandtable-ai --version`, or `sandtable --version` after `pip install`, should print 1.x. On Python 3.9, pip and uv either install 0.2.1, an unsupported pre-1.0 release, or report no matching distribution, and the fix is to upgrade to Python 3.10 or later.

Docs: https://sandtable.dev · Source: https://github.com/sandtable-ai/sandtable
