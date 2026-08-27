---
"opinionated-machine": patch
---

Stop `ApiSseConnectionRegistry` from retaining pending-join state for dead connections.

`unregister` and `evict` cancelled a connection's in-flight `authorizeJoin` tokens but left the map entry behind. The entry is normally removed when the verdict settles, so a verdict that never resolves kept the connection id and its tokens alive after the session was gone, and `closeRoom` walked the retained keys. Both paths now delete the entry; cancellation rides on the token object the join closure captured, so a late verdict still settles as revoked.
