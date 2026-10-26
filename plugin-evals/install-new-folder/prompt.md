---
plugins: ["../../plugin"]
description: In a folder with no package.json, the install advice makes the folder its own npm project before installing, so npm doesn't install into a parent project.
tags: [install, skill-401]
max_turns: 10
allowed_tools: [Read, Glob, Grep, Skill]
---

This folder only holds what Wrenfield Outfitters sent us, in discovery/. We want to draft a sandtable domain here, with Claude on Amazon Bedrock for the model steps, and we'd rather not install anything globally. What exactly do we run, in order, to install sandtable in this folder?
