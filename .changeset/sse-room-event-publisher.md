---
"opinionated-machine": minor
---
Add `SSERoomEventPublisher`: fire-and-forget room broadcasting for domain code. It validates a payload against the event's own schema before broadcasting, and broadcasts the parsed value so schema defaults reach the wire. `publish` throws on a payload that violates its schema, since nobody receives that event and a producer should not believe otherwise; `safePublish` returns `Either<InternalError, true>` instead, for a caller that cannot absorb a throw. A failed broadcast is logged by both, as it happens after the call returns. Accepts the caller's context (anything with a `logger`, such as a `RequestContext`) so failures carry a correlation id.
