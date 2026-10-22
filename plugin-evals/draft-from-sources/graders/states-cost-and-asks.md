---
type: llm
weight: 2
---

PASS if the final reply, before any model-backed `init` step has run, tells the engineer what the next steps cost and asks for a go-ahead: that `init --sop` makes one model call and `init --transcripts` one per transcript (five calls for the SOP and the four chats), which model and provider they would use (Claude on Amazon Bedrock), and a rough cost in dollars.
FAIL if it ran `init --sop` or `init --transcripts` without `--dry-run` (a dry run calls no model and is fine), or leaves out the number of calls or the cost, or doesn't ask before going on.
