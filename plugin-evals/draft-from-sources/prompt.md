---
plugins: ["../../plugin"]
description: Drafting from sources runs the free OpenAPI step, then stops before the model-backed steps and says what they cost.
tags: [drafting, skill-295, skill-296, skill-301]
max_turns: 30
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Bash, Write, Edit]
---

We're building a returns agent for Wrenfield Outfitters. In discovery/ I put what they sent us: their order service's OpenAPI spec (openapi.yaml), their returns SOP (sop.md) and four support chats in discovery/transcripts/. sandtable-ai is already installed in this project. Draft a sandtable domain from them into ./sandtable. We run model steps on Claude through Amazon Bedrock.
