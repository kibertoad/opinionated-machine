import type { SSEEventSchemas } from '@lokalise/api-contracts'
import type {
  ApiRouteOptions as FastifyApiRouteOptions,
  SSESession,
} from '@lokalise/fastify-api-contracts'
import type { SSERoomBroadcaster } from '../sse/rooms/SSERoomBroadcaster.ts'
import type { SSERoomOperations } from '../sse/rooms/types.ts'
import type { SSEMessage } from '../sse/sseTypes.ts'

/**
 * Connection registry bridging `buildApiRoute` SSE sessions to a shared
 * `SSERoomBroadcaster`.
 *
 * The legacy SSE/dual-mode controllers register their own `sendEvent` with
 * the broadcaster; `buildApiRoute` routes have no controller, so this
 * registry keeps the connection-id → send mapping and registers itself
 * as a single broadcaster sender. One registry exists per broadcaster
 * (see {@link getApiSseConnectionRegistry}), shared by all routes and
 * controllers that pass the same `sseRooms` broadcaster.
 */
type RegisteredConnection = {
  send: (message: SSEMessage) => Promise<boolean>
  /** Terminate the underlying stream, when the registrar supplied a way to. */
  close?: () => void
}

export class ApiSseConnectionRegistry {
  private readonly connections = new Map<string, RegisteredConnection>()
  private readonly broadcaster: SSERoomBroadcaster

  constructor(broadcaster: SSERoomBroadcaster) {
    this.broadcaster = broadcaster
    broadcaster.registerSender((connectionId, message) => {
      const connection = this.connections.get(connectionId)
      return connection ? connection.send(message) : Promise.resolve(false)
    })
  }

  /**
   * Register an active SSE connection with its send function.
   * The send function must return `false` (not throw) on delivery failure so
   * room broadcasts keep fanning out to the remaining connections.
   *
   * Pass `close` to make the connection evictable — without it {@link evict}
   * can stop delivery but cannot terminate the stream.
   */
  register(
    connectionId: string,
    send: (message: SSEMessage) => Promise<boolean>,
    close?: () => void,
  ): void {
    this.connections.set(connectionId, { send, ...(close !== undefined ? { close } : {}) })
  }

  /**
   * Remove a connection: drops the sender, leaves all rooms, and clears the
   * broadcaster's dedup cache for the connection.
   */
  unregister(connectionId: string): void {
    this.connections.delete(connectionId)
    this.broadcaster.roomManager.leaveAll(connectionId)
    this.broadcaster.cleanupConnection(connectionId)
  }

  /**
   * Terminate one connection: leave its rooms, stop delivering to it, and
   * close its stream.
   *
   * This is the revocation path. Authorization is checked when a stream opens
   * and then goes stale, so removing a principal's access has to be able to
   * end the streams that access already opened; without a call like this, a
   * revoked user keeps receiving broadcasts until they close the tab.
   *
   * A client that reconnects (as `@opinionated-machine/sse-fallback` does)
   * comes back through the route's own authorization, so an eviction of a
   * still-authorized principal costs a reconnect, not a broken surface.
   *
   * @returns `true` when a connection was registered under that id.
   */
  evict(connectionId: string): boolean {
    const connection = this.connections.get(connectionId)
    if (!connection) return false
    // Leave rooms first: a broadcast racing the close must not reach a
    // connection that is being revoked.
    this.broadcaster.roomManager.leaveAll(connectionId)
    this.connections.delete(connectionId)
    this.broadcaster.cleanupConnection(connectionId)
    connection.close?.()
    return true
  }

  /**
   * Remove one connection from one room, leaving its other rooms and its
   * stream intact. For revoking access to a single scope.
   *
   * @returns `true` when the connection was in the room.
   */
  evictFromRoom(room: string, connectionId: string): boolean {
    if (!this.broadcaster.roomManager.isInRoom(connectionId, room)) return false
    this.broadcaster.roomManager.leave(connectionId, room)
    return true
  }

  /**
   * Evict every connection currently in a room, terminating their streams.
   * For revoking a whole scope (a deleted project, a disbanded team).
   *
   * Only connections on THIS node are closed — room membership elsewhere in
   * the cluster is another node's registry to evict, so a revocation event
   * has to reach every node.
   *
   * @returns How many connections were evicted here.
   */
  closeRoom(room: string): number {
    let evicted = 0
    for (const connectionId of this.broadcaster.roomManager.getConnectionsInRoom(room)) {
      if (this.evict(connectionId)) evicted += 1
    }
    return evicted
  }
}

const registries = new WeakMap<SSERoomBroadcaster, ApiSseConnectionRegistry>()

/**
 * Get (or lazily create) the shared registry for a broadcaster.
 * Ensures `registerSender` is called exactly once per broadcaster no matter
 * how many routes opt into rooms.
 */
export function getApiSseConnectionRegistry(
  broadcaster: SSERoomBroadcaster,
): ApiSseConnectionRegistry {
  let registry = registries.get(broadcaster)
  if (!registry) {
    registry = new ApiSseConnectionRegistry(broadcaster)
    registries.set(broadcaster, registry)
  }
  return registry
}

const NOOP_ROOMS: SSERoomOperations = { join: () => {}, leave: () => {} }

/**
 * Room operations per live session.
 *
 * `@lokalise/fastify-api-contracts` owns the `SSESession` shape and has no
 * `rooms` field, so the operations live beside the session rather than on it.
 * The map is weak: entries disappear with the session object, independently of
 * the explicit cleanup done on close.
 */
const sessionRooms = new WeakMap<object, SSERoomOperations>()

/**
 * Room operations for an SSE session opened by a `buildApiRoute` route.
 *
 * Returns no-ops when the route did not pass `sseRooms` — mirroring the legacy
 * `session.rooms` accessor, which is inert on controllers without a broadcaster.
 *
 * @example
 * ```ts
 * const session = sse.start('keepAlive')
 * getSessionRooms(session).join(`project:${request.params.projectId}`)
 * ```
 */
export function getSessionRooms<Events extends SSEEventSchemas, Context>(
  session: SSESession<Events, Context>,
): SSERoomOperations {
  return sessionRooms.get(session) ?? NOOP_ROOMS
}

/**
 * Room wiring for a route, when the bare broadcaster is not enough.
 *
 * Pass an `SSERoomBroadcaster` directly for the default behaviour; pass this
 * object to add a scope check on joins and a bounded session lifetime.
 */
export type SSERoomsOptions = {
  /** The broadcaster whose rooms this route's sessions join. */
  broadcaster: SSERoomBroadcaster

  /**
   * Decide whether a session may join a room. Declared once per route, so the
   * scope check is not left to every handler body.
   *
   * Without it, `getSessionRooms(session).join(room)` joins whatever room
   * string the handler names, and nothing checks that the authenticated
   * principal belongs to that room's scope — a path param read straight into
   * a room name is a cross-tenant leak.
   *
   * Return `false` (or reject) to refuse; the refusal is logged on the
   * request logger and the join is dropped. A synchronous verdict is applied
   * before `join()` returns; an async one is applied when it resolves, so the
   * session joins a moment later — the client's reconciliation poll covers
   * anything broadcast in between.
   */
  authorizeJoin?: (session: SSESession, room: string) => boolean | Promise<boolean>

  /**
   * Close the session gracefully after this many milliseconds.
   *
   * Authorization is checked when the stream opens and then goes stale: a
   * principal removed from a scope keeps receiving events for as long as the
   * connection lives. A bounded lifetime forces a reconnect, and the reconnect
   * re-runs authentication and authorization — making this both the
   * token-refresh mechanism and the backstop for a revocation that never
   * reached {@link ApiSseConnectionRegistry.evict}.
   *
   * A client that treats a server close as a routine reconnect (with
   * `Last-Event-ID` and a reconciliation poll, as
   * `@opinionated-machine/sse-fallback` does) makes this invisible to users.
   */
  maxSessionLifetimeMs?: number
}

function normalizeRoomsOptions(config: SSERoomBroadcaster | SSERoomsOptions): SSERoomsOptions {
  return 'broadcaster' in config ? config : { broadcaster: config }
}

/** Per-session lifetime timers, cleared when the session closes. */
const lifetimeTimers = new WeakMap<object, ReturnType<typeof setTimeout>>()

/**
 * Compose room wiring into a route's SSE lifecycle hooks.
 *
 * On connect the session is registered with the broadcaster's registry and its
 * room operations are published for {@link getSessionRooms}; on close the
 * connection is unregistered (rooms left, dedup cache cleared). The route's own
 * `onConnect` / `onClose` hooks still run — room wiring is applied first on
 * connect (so a hook can already join rooms) and last on close.
 *
 * `onConnect` is invoked synchronously by the package's `sse.start()`, so the
 * registration is in place before `start()` returns to the handler.
 *
 * Pass {@link SSERoomsOptions} instead of a bare broadcaster to add an
 * `authorizeJoin` scope check or a `maxSessionLifetimeMs` bound.
 */
export function withSessionRooms<Options extends FastifyApiRouteOptions>(
  config: SSERoomBroadcaster | SSERoomsOptions,
  options: Options,
): Options {
  const { broadcaster, authorizeJoin, maxSessionLifetimeMs } = normalizeRoomsOptions(config)
  const registry = getApiSseConnectionRegistry(broadcaster)
  const { onConnect, onClose } = options

  return {
    ...options,
    onConnect: (session) => {
      registry.register(
        session.id,
        (message) =>
          // The session's `send` validates against the contract's event schemas and
          // throws on a mismatch. A broadcaster sender must not throw — one bad
          // message would abort the fan-out for every other connection — so the
          // failure is logged and reported as an undelivered message instead.
          (
            session.send as (
              event: string,
              data: unknown,
              options?: SendOptions,
            ) => Promise<boolean>
          )(message.event ?? '', message.data, { id: message.id, retry: message.retry }).catch(
            (err: unknown) => {
              session.request.log.error(
                { err, event: message.event },
                'SSE room broadcast rejected for connection',
              )
              return false
            },
          ),
        () => session.close(),
      )

      if (maxSessionLifetimeMs !== undefined) {
        const timer = setTimeout(() => {
          if (!session.isConnected()) return
          session.request.log.info(
            { connectionId: session.id, maxSessionLifetimeMs },
            'closing SSE session at its lifetime bound',
          )
          session.close()
        }, maxSessionLifetimeMs)
        ;(timer as { unref?: () => void }).unref?.()
        lifetimeTimers.set(session, timer)
      }

      const joinRoom = (room: string): void => {
        // Guard against startup races where the stream is already dead:
        // joining such a session would leave stale room members behind.
        if (!session.isConnected()) return
        broadcaster.roomManager.join(session.id, room)
      }

      const denied = (room: string, err?: unknown): void => {
        session.request.log.warn(
          { connectionId: session.id, room, ...(err !== undefined ? { err } : {}) },
          'SSE room join refused by authorizeJoin',
        )
      }

      const authorizeAndJoin = (room: string): void => {
        if (!authorizeJoin) {
          joinRoom(room)
          return
        }
        let verdict: boolean | Promise<boolean>
        try {
          verdict = authorizeJoin(session as SSESession, room)
        } catch (err) {
          denied(room, err)
          return
        }
        if (verdict === true) {
          joinRoom(room)
          return
        }
        if (verdict === false) {
          denied(room)
          return
        }
        void verdict.then(
          (allowed) => (allowed ? joinRoom(room) : denied(room)),
          (err: unknown) => denied(room, err),
        )
      }

      sessionRooms.set(session, {
        join: (room) => {
          for (const name of Array.isArray(room) ? room : [room]) authorizeAndJoin(name)
        },
        leave: (room) => broadcaster.roomManager.leave(session.id, room),
      })

      return onConnect?.(session)
    },
    onClose: async (session, initiator) => {
      try {
        await onClose?.(session, initiator)
      } finally {
        const timer = lifetimeTimers.get(session)
        if (timer !== undefined) {
          clearTimeout(timer)
          lifetimeTimers.delete(session)
        }
        sessionRooms.delete(session)
        registry.unregister(session.id)
      }
    },
  }
}

type SendOptions = { id?: string; retry?: number }
