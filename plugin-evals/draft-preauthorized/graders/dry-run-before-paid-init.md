---
type: regex
target: trace
# The plan before the spend: an `init` with --sop or --transcripts and --dry-run comes before any such `init` without
# --dry-run. Fails when the paid command comes first, or when no dry run happens at all. JSON-escaped quotes inside a
# command don't end it.
pattern: '^(?:(?!"command":"(?!(?:[^"\\]|\\.)*--dry-run)(?:[^"\\]|\\.)*\binit\b(?:[^"\\]|\\.)*--(?:sop|transcripts))[\s\S])*?"command":"(?=(?:[^"\\]|\\.)*--dry-run)(?:[^"\\]|\\.)*\binit\b(?:[^"\\]|\\.)*--(?:sop|transcripts)'
match: contains
weight: 2
---
