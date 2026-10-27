---
type: regex
target: trace
# The plan before the spend: an `init` with --sop or --transcripts and --dry-run comes before any such `init` without
# --dry-run. Fails when the paid command comes first, or when no dry run happens at all. JSON-escaped quotes inside a
# command don't end it.
# A paid init the plugin's hook denied (its tool result says "sandtable plugin: ...") never ran, so it doesn't count:
# a paid init counts only when no denial comes before the next command.
pattern: '^(?:(?!"command":"(?!(?:[^"\\]|\\.)*--dry-run)(?:[^"\\]|\\.)*\binit\b(?:[^"\\]|\\.)*--(?:sop|transcripts)(?:[^"\\]|\\.)*"(?:(?!"command":|sandtable plugin: )[\s\S])*(?:"command":|$))[\s\S])*?"command":"(?=(?:[^"\\]|\\.)*--dry-run)(?:[^"\\]|\\.)*\binit\b(?:[^"\\]|\\.)*--(?:sop|transcripts)'
match: contains
weight: 2
---
