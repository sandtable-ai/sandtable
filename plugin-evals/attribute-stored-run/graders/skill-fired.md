---
type: regex
target: trace
# Plugin use: the running-and-reading-results skill loaded, or the run was handed to the plugin's failure-triager agent,
# which the skill recommends for reading transcripts. A tool_used grader names one tool, so this reads the trace for
# either call's input. arm: with-only keeps it the plugin-fired indicator under --ablation with-without, as a
# `tool_used: Skill` grader is.
pattern: '"skill"\s*:\s*"(?:[\w-]+:)?running-and-reading-results"|"subagent_type"\s*:\s*"(?:[\w-]+:)?failure-triager"'
match: contains
arm: with-only
---
