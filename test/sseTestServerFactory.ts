import FastifySSEPlugin from '@fastify/sse'
import fastify, { type FastifyInstance } from 'fastify'
import { SSETestServer } from '../index.js'

/**
 * Options for creating an SSE test server with the internal factory.
 */
export type CreateSSETestServerOptions<T> = {
  /**
   * Configure the Fastify instance before SSE routes are registered.
   * Use this to add plugins, validators, etc.
   */
  configureApp?: (app: FastifyInstance) => void | Promise<void>
  /**
   * Custom setup function that returns resources available via `result.resources`.
   */
  setup?: () => T | Promise<T>
}

export type SSETestServerWithResources<T> = SSETestServer & { resources: T }

/**
 * Internal factory for creating SSE test servers with full app setup.
 *
 * This is a convenience wrapper used only by the library's own tests.
 * It creates a Fastify app with @fastify/sse pre-registered, configures it,
 * registers routes, and starts it via SSETestServer.start().
 *
 * External consumers should use SSETestServer.start(app) with their own app factory.
 */
export async function createSSETestServer(
  registerRoutes: (app: FastifyInstance) => void | Promise<void>,
): Promise<SSETestServerWithResources<undefined>>
export async function createSSETestServer<T>(
  registerRoutes: (app: FastifyInstance) => void | Promise<void>,
  options: CreateSSETestServerOptions<T>,
): Promise<SSETestServerWithResources<T>>
export async function createSSETestServer<T = undefined>(
  registerRoutes: (app: FastifyInstance) => void | Promise<void>,
  options?: CreateSSETestServerOptions<T>,
): Promise<SSETestServerWithResources<T>> {
  // Create Fastify app
  const app = fastify()

  // Register SSE plugin (type assertion needed due to @fastify/sse's module.exports pattern)
  await app.register(FastifySSEPlugin as unknown as Parameters<typeof app.register>[0])

  // Run custom configuration
  if (options?.configureApp) {
    await options.configureApp(app)
  }

  // Setup custom resources
  const resources = options?.setup ? await options.setup() : (undefined as T)

  // Register routes
  await registerRoutes(app)

  // Start the server
  const server = await SSETestServer.start(app)

  // Attach resources to the server instance
  return Object.assign(server, { resources })
}
