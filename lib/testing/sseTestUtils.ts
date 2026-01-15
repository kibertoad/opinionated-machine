/**
 * SSE testing utilities.
 *
 * This module provides helpers for testing SSE (Server-Sent Events) endpoints
 * in Fastify applications.
 *
 * @module sseTestUtils
 */

// Re-export parsing utilities (from production module)
export { type ParsedSSEEvent, parseSSEBuffer, parseSSEEvents } from '../sse/sseParser.ts'
// Re-export SSE HTTP client class (uses real HTTP for long-lived connections)
export { SSEHttpClient } from './sseConnect.ts'
// Re-export contract-aware inject helpers
export { buildUrl, injectPayloadSSE, injectSSE } from './sseInjectHelpers.ts'
// Re-export SSE inject client class (uses Fastify inject for testing)
export { SSEInjectClient } from './sseTestClient.ts'
// Re-export test server class
export { SSETestServer } from './sseTestServer.ts'
// Re-export types
export type {
  CreateSSETestServerOptions,
  InjectPayloadSSEOptions,
  InjectSSEOptions,
  InjectSSEResult,
  SSEConnectOptions,
  SSEResponse,
  SSETestConnection,
} from './sseTestTypes.ts'
