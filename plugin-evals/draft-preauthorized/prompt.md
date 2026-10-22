---
plugins: ["../../plugin"]
description: With model steps authorized up front, drafting still states the calls, model and cost before the first model-backed init step, then goes on.
tags: [drafting, skill-296]
max_turns: 30
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Bash, Write, Edit]
---

We're building a returns agent for Wrenfield Outfitters. In discovery/ I put what they sent us: their order service's OpenAPI spec (openapi.yaml), their returns SOP (sop.md) and four support chats in discovery/transcripts/. sandtable-ai and @anthropic-ai/bedrock-sdk are installed in this project. Draft a sandtable domain from them into ./sandtable. Use Claude Sonnet 5.5 on Amazon Bedrock in eu-west-1 for any model step; you don't need to ask me before running them.
