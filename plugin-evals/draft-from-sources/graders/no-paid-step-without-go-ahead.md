---
type: tool_used
tool: Bash
# A paid step: an `init` with --sop or --transcripts and without --dry-run, read one command at a time (up to the next
# &&, ||, ; or line break). A dry run calls no model, and the skill runs one before asking, so it doesn't count, but a
# paid init chained after one does. JSON-escaped quotes inside a command don't end it.
input_match: '"command"\s*:\s*"(?:[^"\\]|\\.)*?\binit\b(?:(?!--dry-run|&&|\|\||;|\\n)(?:[^"\\]|\\.))*?--(?:sop|transcripts)\b(?:(?!--dry-run|&&|\|\||;|\\n)(?:[^"\\]|\\.))*(?:&&|\|\||;|\\n|")'
min: 0
max: 0
weight: 2
---
