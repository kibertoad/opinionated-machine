import type { AnySSEContractDefinition } from '@lokalise/api-contracts'
import type { FastifyInstance } from 'fastify'
import type { z } from 'zod'
import type { ParsedSSEEvent } from '../sse/sseParser.ts'

/**
 * Represents an active SSE test connection (inject-based).
 *
 * This interface is used with Fastify's inject() for testing SSE endpoints
 * synchronously. For long-lived connections, use SSEHttpClient instead.
 */
export interface SSETestConnection {
  /**
   * Wait for a specific event by name.
   * @param eventName - The event name to wait for
   * @param timeout - Timeout in milliseconds (default: 5000)
   */
  waitForEvent(eventName: string, timeout?: number): Promise<ParsedSSEEvent>

  /**
   * Wait for a specific number of events.
   * @param count - Number of events to wait for
   * @param timeout - Timeout in milliseconds (default: 5000)
   */
  waitForEvents(count: number, timeout?: number): Promise<ParsedSSEEvent[]>

  /**
   * Get all events received so far.
   */
  getReceivedEvents(): ParsedSSEEvent[]

  /**
   * Close the connection.
   */
  close(): void

  /**
   * Check if connection is closed.
   */
  isClosed(): boolean

  /**
   * Get the HTTP response status code.
   */
  getStatusCode(): number

  /**
   * Get response headers.
   */
  getHeaders(): Record<string, string | string[] | undefined>
}

/**
 * Options for establishing an SSE connection.
 */
export type SSEConnectOptions = {
  headers?: Record<string, string>
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH'
  body?: unknown
}

/**
 * Options for injectSSE (GET SSE routes).
 */
export type InjectSSEOptions<Contract extends AnySSEContractDefinition> = {
  params?: z.infer<Contract['requestPathParamsSchema']>
  query?: z.infer<Contract['requestQuerySchema']>
  headers?: z.infer<Contract['requestHeaderSchema']>
}

/**
 * Options for injectPayloadSSE (POST/PUT/PATCH SSE routes).
 */
export type InjectPayloadSSEOptions<Contract extends AnySSEContractDefinition> = {
  params?: z.infer<Contract['requestPathParamsSchema']>
  query?: z.infer<Contract['requestQuerySchema']>
  headers?: z.infer<Contract['requestHeaderSchema']>
  body: Contract['requestBodySchema'] extends z.ZodTypeAny
    ? z.infer<Contract['requestBodySchema']>
    : never
}

/**
 * SSE response data.
 */
export type SSEResponse = {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

/**
 * Result of an SSE inject call.
 *
 * Note: Fastify's inject() waits for the full response, so these helpers
 * work best for streaming that completes (OpenAI-style). For long-lived
 * SSE connections, use `SSEHttpClient` with a real HTTP server instead.
 */
export type InjectSSEResult = {
  /**
   * Resolves when the response completes with the full SSE body.
   * Parse the body with `parseSSEEvents()` to get individual events.
   */
  closed: Promise<SSEResponse>
}

/**
 * Options for creating an SSE test server.
 */
export type CreateSSETestServerOptions<T> = {
  /**
   * Configure the Fastify instance before SSE routes are registered.
   * Use this to add plugins, validators, etc.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Fastify instance types are complex
  configureApp?: (app: FastifyInstance<any, any, any, any>) => void | Promise<void>
  /**
   * Custom setup function that returns resources to be cleaned up.
   * The returned value will be passed to the cleanup function.
   */
  setup?: () => T | Promise<T>
}
