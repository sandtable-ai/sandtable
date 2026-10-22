---
plugins: ["../../plugin"]
description: Attributing a stored run's failures doesn't blame an agent that was right, and blames a caller that invented a fact.
tags: [results, skill-299]
max_turns: 30
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Bash]
---

Our agent's last rehearsal is in .sandtable/runs/2026-11-02T09-00-00-000Z-wrenfield-returns/results.json, run against the domain in sandtable/. Three tasks failed. For each one, tell me who's at fault (our agent, the simulated caller, the task spec, or infrastructure), the evidence, and the fix. Don't run anything that calls a model.
