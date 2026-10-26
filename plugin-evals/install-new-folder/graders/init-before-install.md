---
type: regex
# The folder has no package.json, so an `npm install` there would go to the nearest project above it. The advice
# makes the folder a project first: `npm init` comes before the install of sandtable-ai.
pattern: 'npm init\b[\s\S]*?npm (install|i) (--save-dev|-D)[^\n]*sandtable-ai'
flags: i
weight: 2
---
