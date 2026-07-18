/**
 * Strategy for answering "does any node in the cluster have a subscriber
 * in this room right now?" before publishing.
 *
 * The adapter consults a tracker (when configured) and skips the underlying
 * `PUBLISH` / `SPUBLISH` when `hasSubscribers` returns `false`. This is an
 * opt-in optimisation: adapters constructed without a tracker behave exactly
 * as they did before.
 *
 * Failure policy: if `hasSubscribers` throws or rejects, the adapter publishes
 * anyway (fail-open). Skipping a "possibly" subscribed publish would silently
 * drop legitimate messages; skipping only "known no-op" publishes is safe.
 *
 * Implementations are expected to cache. A Redis round-trip per outbound
 * publish would defeat the optimisation.
 */
export interface PresenceTracker {
  /**
   * Returns true if any node anywhere in the cluster currently has at least
   * one subscriber in `room`. May return synchronously or asynchronously.
   */
  hasSubscribers(room: string): boolean | Promise<boolean>

  /**
   * Optional hook fired by the adapter after `SUBSCRIBE` / `SSUBSCRIBE`
   * resolves for a room (i.e. the local node just gained its first connection
   * in this room). Implementations may use it to invalidate or pre-warm cache
   * entries.
   */
  notifyLocalSubscribed?(room: string): void

  /**
   * Optional hook fired by the adapter after `UNSUBSCRIBE` / `SUNSUBSCRIBE`
   * resolves for a room (i.e. the local node lost its last connection in this
   * room). Implementations may use it to invalidate cache entries.
   */
  notifyLocalUnsubscribed?(room: string): void

  /**
   * Optional teardown hook called from the adapter's `disconnect()`.
   * Use to clear timers, drop cache, or release resources.
   */
  dispose?(): void | Promise<void>
}

/**
 * Minimal Redis client shape required by the bundled presence trackers,
 * which need to issue raw commands (`PUBSUB NUMSUB`, `PUBSUB SHARDNUMSUB`)
 * not exposed by `RedisClientLike`.
 *
 * - `ioredis` exposes `call(command, ...args)`.
 * - `node-redis` (v4+) exposes `sendCommand(args[])`.
 *
 * Implementations only need ONE of the two — the tracker picks whichever is
 * defined. Constructors throw if neither is present.
 *
 * The parameter and return types are intentionally permissive so that real
 * library client types (ioredis `Redis`/`Cluster`, node-redis clients) — which
 * declare additional overloads and richer argument types than we strictly
 * need — can be passed without manual casting. The tracker invokes both with
 * tightly typed arguments internally.
 */
export type NumsubCapableClient = {
  // biome-ignore lint/suspicious/noExplicitAny: structural compat with ioredis/node-redis signatures
  call?: (...args: any[]) => Promise<unknown>
  // Permissive on purpose: ioredis declares `sendCommand` with a `Command`
  // object argument and `unknown` return, while node-redis declares `(args:
  // string[]) => Promise<unknown>`. Trackers only invoke `sendCommand` when
  // `call` is unavailable (the node-redis path), so the runtime signature is
  // always what we need — only the type system needs to accommodate both.
  // biome-ignore lint/suspicious/noExplicitAny: structural compat with ioredis/node-redis signatures
  sendCommand?: (...args: any[]) => any
}
