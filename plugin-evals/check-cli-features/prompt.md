---
plugins: ["../../plugin"]
description: Asked for a feature the installed CLI lacks, the agent finds out from the CLI itself and says so, instead of guessing or reading npx's cache.
tags: [cli, skill-301]
max_turns: 25
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Bash, Edit, Write]
---

guest-receipt is a release blocker for us: if any trial of it fails, our CI run should fail, whatever the overall score. Set that up in sandtable/ and make sure the domain still validates with the sandtable-ai this project has installed.
