---
type: llm
---

PASS if the review says the task claimed-gold-but-guest-denied contradicts its source chat, chat-3101.txt: in the chat the customer (account A-519) is a gold member whose return is approved, while the task makes her the guest account A-503 and expects the return to be declined.
FAIL if the review doesn't flag that task, or flags it only for an unrelated reason.
