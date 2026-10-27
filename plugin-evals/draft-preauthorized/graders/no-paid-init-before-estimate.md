---
type: regex
target: trace
# A paid init command (with --sop or --transcripts, without --dry-run) with no estimate said before it. An estimate is
# an assistant text block that names the calls and a dollar amount ("Plan: 5 model calls … about $0.90"); the skill's
# own text and the dry run's output, which aren't the agent's words, don't count. Weight 1: the dry run is the gate.
# A paid init the plugin's hook denied (its tool result says "sandtable plugin: ...") never ran, so it doesn't count:
# a paid init counts only when no denial comes before the next command.
pattern: '^(?:(?!\{"type":"assistant"[^\n]*?"type":"text","text":"(?=(?:[^"\\\n]|\\.)*?\$\s?[0-9])(?=(?:[^"\\\n]|\\.)*?\bcalls?\b))[\s\S])*?"command":"(?!(?:[^"\\]|\\.)*--dry-run)(?:[^"\\]|\\.)*\binit\b(?:[^"\\]|\\.)*--(?:sop|transcripts)(?:[^"\\]|\\.)*"(?:(?!"command":|sandtable plugin: )[\s\S])*(?:"command":|$)'
match: not_contains
weight: 1
---
