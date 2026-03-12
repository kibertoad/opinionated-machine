import type { FastifyInstance } from 'fastify'

/**
 * Test server wrapper that starts a Fastify app on a random port for testing.
 *
 * Use `SSETestServer.start(app)` with your pre-configured Fastify app:
 *
 * ```typescript
 * const app = getApp() // your app factory
 * const server = await SSETestServer.start(app)
 * // server.baseUrl → "http://localhost:xxxxx"
 * // server.app → the Fastify instance
 *
 * const { client } = await SSEHttpClient.connect(server.baseUrl, '/api/events', ...)
 * // ... test ...
 * client.close()
 * await server.close()
 * ```
 */
export class SSETestServer {
  /** The Fastify instance */
  readonly app: FastifyInstance
  /** Base URL for the running server (e.g., "http://localhost:3000") */
  readonly baseUrl: string

  private constructor(app: FastifyInstance, baseUrl: string) {
    this.app = app
    this.baseUrl = baseUrl
  }

  /**
   * Start a pre-configured Fastify app on a random port for testing.
   *
   * The app should have routes and plugins already registered —
   * this method only starts the HTTP listener.
   *
   * @param app - A fully configured Fastify instance (routes, plugins, etc. already registered)
   * @returns A running SSETestServer with `baseUrl` and `app`
   *
   * @example
   * ```typescript
   * const app = getApp() // your app factory that creates & configures Fastify
   * const server = await SSETestServer.start(app)
   *
   * const { client } = await SSEHttpClient.connect(
   *   server.baseUrl,
   *   '/api/events',
   *   { awaitServerConnection: { controller } },
   * )
   *
   * // ... test ...
   * client.close()
   * await server.close()
   * ```
   */
  static async start(app: FastifyInstance): Promise<SSETestServer> {
    await app.listen({ port: 0 })
    const address = app.server.address()
    const baseUrl = typeof address === 'string' ? address : `http://localhost:${address?.port}`

    return new SSETestServer(app, baseUrl)
  }

  /**
   * Close the server and cleanup resources.
   */
  async close(): Promise<void> {
    await this.app.close()
  }
}
