---
type: regex
target: trace
pattern: '"(command|file_path|path|pattern)":"[^"]*(\.npm/_npx|node_modules/sandtable-ai/dist)'
match: not_contains
---
