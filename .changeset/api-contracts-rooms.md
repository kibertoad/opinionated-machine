---
"opinionated-machine": minor
---

Add SSE rooms support to the modern api-contracts path.

`buildApiRoute` accepts a new `sseRooms: SSERoomBroadcaster` option: sessions started by the route's SSE handler get working `session.rooms.join()/leave()` (previously silent no-ops in this path), receive room broadcasts, and are cleaned up (rooms left, dedup cache cleared) when the connection closes. This makes the dual-mode fallback pattern possible with `AbstractApiController`: the sync branch answers polls while a domain service broadcasts into a room the SSE branch joined. The new `ApiSseConnectionRegistry` bridges connections to a shared broadcaster.
