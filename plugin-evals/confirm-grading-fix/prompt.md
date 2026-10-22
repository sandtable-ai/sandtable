---
plugins: ["../../plugin"]
description: A grading-only fix is confirmed with regrade, without a model call, keeping the original run.
tags: [results, skill-300]
max_turns: 30
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Bash]
---

The account-before-order rule was stricter than our SOP, so I just made it `soft: true` in sandtable/sandtable.yaml. Confirm that this fixes return-jacket-gold, using our last run in .sandtable/runs/2026-11-02T09-00-00-000Z-wrenfield-returns/results.json. Keep that run's files as they are.
