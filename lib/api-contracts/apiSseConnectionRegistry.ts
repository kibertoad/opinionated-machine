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
export class ApiSseConnectionRegistry {
  private readonly connections = new Map<string, (msg: SSEMessage) => Promise<boolean>>()
  private readonly broadcaster: SSERoomBroadcaster

  constructor(broadcaster: SSERoomBroadcaster) {
    this.broadcaster = broadcaster
    broadcaster.registerSender((connectionId, message) => {
      const send = this.connections.get(connectionId)
      return send ? send(message) : Promise.resolve(false)
    })
  }

  /**
   * Register an active SSE connection with its send function.
   * The send function must return `false` (not throw) on delivery failure so
   * room broadcasts keep fanning out to the remaining connections.
   */
  register(connectionId: string, send: (message: SSEMessage) => Promise<boolean>): void {
    this.connections.set(connectionId, send)
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
 */
export function withSessionRooms<Options extends FastifyApiRouteOptions>(
  broadcaster: SSERoomBroadcaster,
  options: Options,
): Options {
  const registry = getApiSseConnectionRegistry(broadcaster)
  const { onConnect, onClose } = options

  return {
    ...options,
    onConnect: (session) => {
      registry.register(session.id, (message) =>
        // The session's `send` validates against the contract's event schemas and
        // throws on a mismatch. A broadcaster sender must not throw — one bad
        // message would abort the fan-out for every other connection — so the
        // failure is logged and reported as an undelivered message instead.
        (session.send as (event: string, data: unknown, options?: SendOptions) => Promise<boolean>)(
          message.event ?? '',
          message.data,
          { id: message.id, retry: message.retry },
        ).catch((err: unknown) => {
          session.request.log.error(
            { err, event: message.event },
            'SSE room broadcast rejected for connection',
          )
          return false
        }),
      )

      sessionRooms.set(session, {
        join: (room) => {
          // Guard against startup races where the stream is already dead:
          // joining such a session would leave stale room members behind.
          if (!session.isConnected()) return
          broadcaster.roomManager.join(session.id, room)
        },
        leave: (room) => broadcaster.roomManager.leave(session.id, room),
      })

      return onConnect?.(session)
    },
    onClose: async (session, initiator) => {
      try {
        await onClose?.(session, initiator)
      } finally {
        sessionRooms.delete(session)
        registry.unregister(session.id)
      }
    },
  }
}

type SendOptions = { id?: string; retry?: number }
