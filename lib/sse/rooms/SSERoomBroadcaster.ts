import { randomUUID } from 'node:crypto'
import type {
  AllContractEventNames,
  AnySSEContractDefinition,
  ExtractEventSchema,
} from '@lokalise/api-contracts'
import type { z } from 'zod'
import type { SSEMessage } from '../sseTypes.js'
import type { SSERoomManager } from './SSERoomManager.js'
import type { RoomBroadcastOptions } from './types.js'

/**
 * Standalone room broadcaster that can be injected into domain services.
 *
 * This class decouples room broadcasting from the SSE controller, allowing
 * domain services, event handlers, and message queue consumers to broadcast
 * to rooms without depending on the controller instance.
 *
 * The controller creates this internally and exposes it via a public getter.
 *
 * @template APIContracts - Map of route names to SSE route definitions
 *
 * @example
 * ```typescript
 * // In your DI module
 * dashboardRoomBroadcaster: asSingletonFunction(
 *   (cradle) => cradle.dashboardController.roomBroadcaster,
 * )
 *
 * // In a domain service
 * class MetricsService {
 *   constructor(private broadcaster: SSERoomBroadcaster<typeof contracts>) {}
 *
 *   async onMetricsUpdate(dashboardId: string, metrics: DashboardMetrics) {
 *     await this.broadcaster.broadcastToRoom(
 *       `dashboard:${dashboardId}`,
 *       'metricsUpdate',
 *       metrics,
 *     )
 *   }
 * }
 * ```
 */
export class SSERoomBroadcaster<APIContracts extends Record<string, AnySSEContractDefinition>> {
  private readonly roomManager: SSERoomManager
  private readonly sendEvent: (connectionId: string, message: SSEMessage) => Promise<boolean>

  constructor(
    roomManager: SSERoomManager,
    sendEvent: (connectionId: string, message: SSEMessage) => Promise<boolean>,
  ) {
    this.roomManager = roomManager
    this.sendEvent = sendEvent
  }

  /**
   * Broadcast a type-safe event to all connections in one or more rooms.
   *
   * Event names and data are validated against the controller's contract schemas
   * at compile time, ensuring only valid events can be broadcast.
   *
   * When broadcasting to multiple rooms, connections in multiple rooms
   * only receive the message once (de-duplicated).
   *
   * @param room - Room name or array of room names
   * @param eventName - Event name (must be defined in one of the controller's contracts)
   * @param data - Event data (must match the schema for the event)
   * @param options - Broadcast options (local, id, retry)
   * @returns Number of local connections the message was sent to
   */
  async broadcastToRoom<EventName extends AllContractEventNames<APIContracts>>(
    room: string | string[],
    eventName: EventName,
    data: ExtractEventSchema<APIContracts, EventName> extends z.ZodTypeAny
      ? z.input<ExtractEventSchema<APIContracts, EventName>>
      : never,
    options?: RoomBroadcastOptions & { id?: string; retry?: number },
  ): Promise<number> {
    // Generate a stable message ID for deduplication if not provided
    const messageId = options?.id ?? randomUUID()

    const message: SSEMessage = {
      event: eventName,
      data,
      id: messageId,
      retry: options?.retry,
    }

    const rooms = Array.isArray(room) ? room : [room]
    const connectionIds = this.collectRoomConnections(rooms)

    // Send to all local connections
    let sent = 0
    for (const connId of connectionIds) {
      if (await this.sendEvent(connId, message)) {
        sent++
      }
    }

    // Publish to adapter for cross-node propagation (unless local-only)
    if (!options?.local) {
      for (const r of rooms) {
        await this.roomManager.publish(r, message, options)
      }
    }

    return sent
  }

  /**
   * Get all connection IDs in a room.
   *
   * @param room - The room to query
   * @returns Array of connection IDs
   */
  getConnectionsInRoom(room: string): string[] {
    return this.roomManager.getConnectionsInRoom(room)
  }

  /**
   * Get the number of connections in a room.
   *
   * @param room - The room to query
   * @returns Number of connections
   */
  getConnectionCountInRoom(room: string): number {
    return this.roomManager.getConnectionCountInRoom(room)
  }

  /**
   * Collect unique connection IDs from multiple rooms.
   */
  private collectRoomConnections(rooms: string[]): Set<string> {
    const connectionIds = new Set<string>()
    for (const r of rooms) {
      for (const connId of this.roomManager.getConnectionsInRoom(r)) {
        connectionIds.add(connId)
      }
    }
    return connectionIds
  }
}
