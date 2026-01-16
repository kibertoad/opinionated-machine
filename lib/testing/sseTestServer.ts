import FastifySSEPlugin from '@fastify/sse'
import fastify, { type FastifyInstance } from 'fastify'
import type { CreateSSETestServerOptions } from './sseTestTypes.ts'

/**
 * Test server for SSE e2e testing with automatic setup and cleanup.
 *
 * This class simplifies SSE e2e test setup by:
 * - Creating a Fastify instance with @fastify/sse plugin pre-registered
 * - Starting a real HTTP server on a random port
 * - Providing a base URL for making HTTP requests
 * - Handling cleanup on close()
 *
 * **When to use SSETestServer:**
 * - Testing with `SSEHttpClient` (requires real HTTP server)
 * - E2E tests that need to verify actual network behavior
 * - Tests that need to run controller code in a real server context
 *
 * **Note:** For simple tests using `SSEInjectClient`, you don't need this class -
 * you can use the Fastify instance directly without starting a server.
 *
 * @example
 * ```typescript
 * // Basic usage
 * const server = await SSETestServer.create(async (app) => {
 *   // Register your SSE routes
 *   app.get('/api/events', async (request, reply) => {
 *     reply.sse({ event: 'message', data: { hello: 'world' } })
 *     reply.sseClose()
 *   })
 * })
 *
 * // Connect using SSEHttpClient
 * const client = await SSEHttpClient.connect(server.baseUrl, '/api/events')
 * const events = await client.collectEvents(1)
 * expect(events[0].event).toBe('message')
 *
 * // Cleanup
 * client.close()
 * await server.close()
 * ```
 *
 * @example
 * ```typescript
 * // With custom resources (e.g., DI container, controllers)
 * const server = await SSETestServer.create(
 *   async (app) => {
 *     // Routes can access resources via closure
 *     myController.registerRoutes(app)
 *   },
 *   {
 *     configureApp: async (app) => {
 *       // Configure validators, plugins, etc.
 *       app.setValidatorCompiler(validatorCompiler)
 *     },
 *     setup: async () => {
 *       // Create resources that will be available via server.resources
 *       const container = createContainer()
 *       const controller = container.resolve('sseController')
 *       return { container, controller }
 *     },
 *   }
 * )
 *
 * // Access resources to interact with the server
 * const { controller } = server.resources
 * controller.broadcastEvent({ event: 'update', data: { value: 42 } })
 *
 * await server.close()
 * ```
 */
export class SSETestServer<T = undefined> {
  /** The Fastify instance */
  readonly app: FastifyInstance
  /** Base URL for the running server (e.g., "http://localhost:3000") */
  readonly baseUrl: string
  /** Custom resources from setup function */
  readonly resources: T

  private constructor(app: FastifyInstance, baseUrl: string, resources: T) {
    this.app = app
    this.baseUrl = baseUrl
    this.resources = resources
  }

  /**
   * Create and start a test server.
   * @param registerRoutes - Function to register routes on the Fastify instance
   */
  static async create(
    registerRoutes: (app: FastifyInstance) => void | Promise<void>,
  ): Promise<SSETestServer<undefined>>
  /**
   * Create and start a test server with custom options and resources.
   * @param registerRoutes - Function to register routes on the Fastify instance
   * @param options - Configuration options including setup function
   */
  static async create<T>(
    registerRoutes: (app: FastifyInstance) => void | Promise<void>,
    options: CreateSSETestServerOptions<T>,
  ): Promise<SSETestServer<T>>
  static async create<T = undefined>(
    registerRoutes: (app: FastifyInstance) => void | Promise<void>,
    options?: CreateSSETestServerOptions<T>,
  ): Promise<SSETestServer<T>> {
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

    // Start the server on random port
    await app.listen({ port: 0 })
    const address = app.server.address()
    const baseUrl = typeof address === 'string' ? address : `http://localhost:${address?.port}`

    return new SSETestServer(app, baseUrl, resources)
  }

  /**
   * Close the server and cleanup resources.
   */
  async close(): Promise<void> {
    await this.app.close()
  }
}
