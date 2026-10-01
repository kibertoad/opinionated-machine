/**
 * Minimal logger interface for SSE route error handling.
 * Compatible with CommonLogger from @lokalise/node-core and pino loggers.
 */
export type SSELogger = {
  error: (obj: Record<string, unknown>, msg: string) => void
  warn?: (obj: Record<string, unknown>, msg: string) => void
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
 * const chunk: SSEMessage = { event: 'chunk', data: { content: 'Hello' } }
 *
 * // String data (e.g., OpenAI-style terminator)
 * const done: SSEMessage = { event: 'done', data: '[DONE]' }
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
