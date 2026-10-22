---
type: regex
target: trace
# A model-backed init command with no estimate before it. An estimate is an assistant text block that names the
# calls and a dollar amount ("5 calls … about $0.90"); the skill's own text, in a user message, doesn't count.
pattern: '^(?:(?!\{"type":"assistant"[^\n]*?"type":"text","text":"(?=(?:[^"\\\n]|\\.)*?\$\s?[0-9])(?=(?:[^"\\\n]|\\.)*?\bcalls?\b))[\s\S])*?"command":"[^"]*init[^"]*--(?:sop|transcripts)'
match: not_contains
weight: 2
---
