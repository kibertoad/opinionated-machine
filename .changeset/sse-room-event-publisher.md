---
"opinionated-machine": minor
---

Add `SSERoomEventPublisher`: fire-and-forget room broadcasting for domain code. It validates a payload against the event's own schema before broadcasting and logs a refused or failed broadcast instead of returning it, so an event listener or message handler that cannot retry a dropped hint does not have to hand-roll that wrapper. Accepts a per-call logger so the failure can carry a request-scoped correlation id.
