import type {
  AllContractEventNames,
  AnySSEContractDefinition,
  ExtractEventSchema,
  SSEEventSchemas,
} from '@lokalise/api-contracts'
import type { z } from 'zod'
import type { SSERoomManagerConfig } from './rooms/types.ts'

// Re-export types that are used locally
export type { SSEEventSchemas, AllContractEventNames, ExtractEventSchema }

/**
 * Flatten all events from all contracts into a single record.
 * Used for type-safe event sending across all controller routes.
 */
export type AllContractEvents<Contracts extends Record<string, AnySSEContractDefinition>> = {
  [EventName in AllContractEventNames<Contracts>]: ExtractEventSchema<Contracts, EventName>
}

/**
 * Minimal logger interface for SSE route error handling.
 * Compatible with CommonLogger from @lokalise/node-core and pino loggers.
 */
export type SSELogger = {
  error: (obj: Record<string, unknown>, msg: string) => void
}

/**
 * SSE message format compatible with @fastify/sse.
 *
 * By default, @fastify/sse JSON-serializes the data field, supporting both objects
 * and primitive values (strings, numbers, booleans). This enables patterns like
 * OpenAI's streaming API where JSON object chunks are followed by a string terminator.
 *
 * The @fastify/sse plugin allows customizing the serialization step via its
 * configuration. For example, you can configure it to send strings raw (without
 * JSON encoding) if your use case requires exact wire format control.
 *
 * @template T - Type of the event data (objects or primitives)
 *
 * @example
 * ```typescript
 * // Object data (common case)
 * await sendEvent(id, { event: 'chunk', data: { content: 'Hello' } })
 *
 * // String data (e.g., OpenAI-style terminator)
 * await sendEvent(id, { event: 'done', data: '[DONE]' })
 * ```
 */
export type SSEMessage<T = unknown> = {
  /** Event name (maps to EventSource 'event' field) */
  event?: string
  /** Event data - objects or primitives, serialized per @fastify/sse config */
  data: T
  /** Event ID for client reconnection via Last-Event-ID */
  id?: string
  /** Reconnection delay hint in milliseconds */
  retry?: number
}

/**
 * Type-safe event sender for SSE connections.
 *
 * This type provides compile-time type checking for event names and their
 * corresponding data payloads based on the contract's event schemas.
 *
 * @template Events - Map of event name to Zod schema (from contract.serverSentEventSchemas)
 *
 * @example
 * ```typescript
 * // Given a contract with serverSentEventSchemas:
 * // serverSentEventSchemas: { chunk: z.object({ content: z.string() }), done: z.object({ tokens: z.number() }) }
 *
 * // The sender will be typed as:
 * send('chunk', { content: 'hello' })  // OK
 * send('done', { tokens: 5 })          // OK
 * send('chunk', { tokens: 5 })         // TS Error: wrong payload for 'chunk'
 * send('invalid', { })                 // TS Error: 'invalid' is not a valid event name
 * ```
 */
export type SSEEventSender<Events extends SSEEventSchemas> = <
  EventName extends keyof Events & string,
>(
  eventName: EventName,
  data: z.input<Events[EventName]>,
  options?: { id?: string; retry?: number },
) => Promise<boolean>

/**
 * Configuration options for SSE controllers.
 */
export type SSEControllerConfig = {
  /**
   * Enable connection spying for testing.
   * When enabled, the controller tracks connections and allows waiting for them.
   * Only enable this in test environments.
   * @default false
   */
  enableConnectionSpy?: boolean

  /**
   * Enable room support for this controller.
   * Rooms allow broadcasting to groups of connections.
   *
   * Pass an empty object `{}` to enable rooms with defaults.
   * Pass configuration to customize behavior (e.g., add Redis adapter).
   *
   * @example Single-node deployment (in-memory)
   * ```typescript
   * { rooms: {} }
   * ```
   *
   * @example Multi-node deployment (Redis)
   * ```typescript
   * import { RedisAdapter } from '@opinionated-machine/sse-rooms-redis'
   *
   * { rooms: { adapter: new RedisAdapter({ pubClient, subClient }) } }
   * ```
   */
  rooms?: SSERoomManagerConfig
}
