---
type: regex
target: { source: file, path: sandtable/tasks.yaml }
pattern: '^\s*critical:'
flags: m
match: not_contains
---
