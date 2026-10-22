---
type: regex
target: trace
# With model steps authorized, it goes on after the plan: a dry run of the model-backed init, then the init itself.
pattern: '"command":"(?=(?:[^"\\]|\\.)*--dry-run)(?:[^"\\]|\\.)*\binit\b(?:[^"\\]|\\.)*--(?:sop|transcripts)[\s\S]*?"command":"(?!(?:[^"\\]|\\.)*--dry-run)(?:[^"\\]|\\.)*\binit\b(?:[^"\\]|\\.)*--(?:sop|transcripts)'
match: contains
---
