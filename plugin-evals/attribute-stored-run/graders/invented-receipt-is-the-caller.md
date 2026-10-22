---
type: llm
---

PASS if the reply attributes guest-receipt to the simulated caller: the caller said it had a receipt although its instructions never mention one, and the agent acted on that, so the fix is to say in the task's caller instructions that she has no receipt.
FAIL if the reply blames the agent alone, or doesn't mention that the caller invented the receipt.
