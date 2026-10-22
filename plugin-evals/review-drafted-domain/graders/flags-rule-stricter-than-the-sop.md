---
type: llm
---

PASS if the review says the invariant account-before-order goes further than the SOP: the SOP asks for the account before starting a return, not before looking up an order, so the rule would fail an agent that looks at the order first. It suggests dropping the rule, making it `soft: true`, or keeping only verify-before-return.
FAIL if the review accepts account-before-order as it is.
