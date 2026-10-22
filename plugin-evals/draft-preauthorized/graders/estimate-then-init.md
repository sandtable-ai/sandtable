---
type: regex
target: trace
# With model steps authorized, it states the estimate and goes on: an estimate, then a model-backed init command.
pattern: '\{"type":"assistant"[^\n]*?"type":"text","text":"(?=(?:[^"\\\n]|\\.)*?\$\s?[0-9])(?=(?:[^"\\\n]|\\.)*?\bcalls?\b)[\s\S]*?"command":"[^"]*init[^"]*--(?:sop|transcripts)'
match: contains
---
