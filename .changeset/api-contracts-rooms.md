---
"opinionated-machine": minor
---

Add SSE rooms support to the modern api-contracts path.

`buildApiRoute` accepts a new `sseRooms: SSERoomBroadcaster` option: sessions opened by the route's SSE handler are registered with the broadcaster (so `broadcastToRoom`/`broadcastMessage` reach them), get room operations via the new `getSessionRooms(session)` accessor, and are cleaned up (rooms left, dedup cache cleared) when the connection closes. This makes the dual-mode fallback pattern possible with `AbstractApiController`: the sync branch answers polls while a domain service broadcasts into a room the SSE branch joined. The new `ApiSseConnectionRegistry` bridges connections to a shared broadcaster, which can serve legacy controllers and `buildApiRoute` routes simultaneously.

Room operations live beside the session rather than on it (`getSessionRooms(session)` rather than `session.rooms`) because `@lokalise/fastify-api-contracts` owns the `SSESession` shape in this path.
