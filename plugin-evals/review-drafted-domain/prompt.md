---
plugins: ["../../plugin"]
description: Reviewing a drafted domain catches a task that contradicts its chat, a seed row that contradicts its task, a caller missing a decisive fact, and a rule stricter than the SOP.
tags: [review, skill-298]
max_turns: 30
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Bash]
---

`sandtable init` drafted the domain in sandtable/ from the files in discovery/: the SOP (sop.md) and four support chats in discovery/transcripts/. Review the pending items against the SOP and the chats, and tell me what to fix before I accept them. Don't accept or change anything yet.
