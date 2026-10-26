---
plugins: ["../../plugin"]
description: In a folder with no package.json, which the request doesn't mention, the install advice makes the folder its own npm project before installing, so npm doesn't install into a parent project.
tags: [install, skill-401]
max_turns: 10
allowed_tools: [Read, Glob, Grep, Skill]
---

We're starting the Wrenfield Outfitters returns agent here: what they sent us is in discovery/. We'll draft a sandtable domain from it, with Claude on Amazon Bedrock for the model steps, and we'd rather not install anything globally. What exactly do we run, in order, to install sandtable?
