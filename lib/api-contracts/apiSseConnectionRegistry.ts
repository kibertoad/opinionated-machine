import type { SSERoomBroadcaster } from '../sse/rooms/SSERoomBroadcaster.ts'
import type { SSEMessage } from '../sse/sseTypes.ts'

/**
 * Connection registry bridging `buildApiRoute` SSE sessions to a shared
 * `SSERoomBroadcaster`.
 *
 * The legacy SSE/dual-mode controllers register their own `sendEvent` with
 * the broadcaster; `buildApiRoute` routes have no controller, so this
 * registry keeps the connection-id → raw-send mapping and registers itself
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
   * Register an active SSE connection with its raw send function.
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
