---
type: regex
target: trace
# With model steps authorized, it goes on after the plan: a dry run of the model-backed init, then the init itself.
# A paid init the plugin's hook denied (its tool result says "sandtable plugin: ...") never ran, so it doesn't count:
# a paid init counts only when no denial comes before the next command.
pattern: '"command":"(?=(?:[^"\\]|\\.)*--dry-run)(?:[^"\\]|\\.)*\binit\b(?:[^"\\]|\\.)*--(?:sop|transcripts)[\s\S]*?"command":"(?!(?:[^"\\]|\\.)*--dry-run)(?:[^"\\]|\\.)*\binit\b(?:[^"\\]|\\.)*--(?:sop|transcripts)(?:[^"\\]|\\.)*"(?:(?!"command":|sandtable plugin: )[\s\S])*(?:"command":|$)'
match: contains
---
