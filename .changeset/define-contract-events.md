---
"opinionated-machine": minor
---

Add `defineContractEvent(contract, name)` and `defineContractEvents(contract)`, which define SSE room events from the events a contract declares, with the schema read off the contract and event names constrained to the contract's own.
