---
type: regex
target: { source: file, path: sandtable/tasks.yaml }
pattern: 'review: pending'
match: "count:4"
weight: 0.5
---
