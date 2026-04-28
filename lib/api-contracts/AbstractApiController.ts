import type { ApiContract } from '@lokalise/api-contracts'
import type { RouteOptions } from 'fastify'
import type { SSESession } from '../routes/fastifyRouteTypes.ts'
import type { SSEReply } from '../routes/fastifyRouteUtils.ts'
import type { SSERoomBroadcaster } from '../sse/rooms/SSERoomBroadcaster.ts'
import type { SSERoomManager } from '../sse/rooms/SSERoomManager.ts'
import { SSESessionSpy } from '../sse/SSESessionSpy.ts'
import type { SSEMessage } from '../sse/sseTypes.ts'
import type { ApiRouteHandler, BuildApiRoutesReturnType } from './apiHandlerTypes.ts'
import {
  _buildApiRouteWithRooms,
  type ApiRouteInternalRoomContext,
  buildApiRoute,
} from './apiRouteBuilder.ts'

export type ApiControllerSseConfig = {
  roomBroadcaster?: SSERoomBroadcaster
  enableConnectionSpy?: boolean
}

/**
 * Abstract base class for controllers that use the `ApiContract` API.
 *
 * Handles all three response modes in a single unified controller:
 * - **non-SSE** — Standard sync/JSON routes
 * - **SSE-only** — Routes that stream SSE events (via `reply.sse` directly)
 * - **dual-mode** — Routes that branch on the `Accept` header
 *
 * Concrete controllers must implement `buildApiRoutes()` and register each
 * route using `buildApiHandler()`.
 *
 * @template APIContracts - Map of route name to `ApiContract`
 *
 * @example
 * ```typescript
 * class UserController extends AbstractApiController<typeof contracts> {
 *   public static readonly contracts = {
 *     getUser: defineApiContract({
 *       method: 'get',
 *       pathResolver: (p) => `/users/${p.userId}`,
 *       requestPathParamsSchema: z.object({ userId: z.string() }),
 *       responsesByStatusCode: { 200: z.object({ id: z.string(), name: z.string() }) },
 *     }),
 *   } as const
 *
 *   public buildApiRoutes() {
 *     return {
 *       getUser: buildApiHandler(UserController.contracts.getUser,
 *         async (request) => ({ id: request.params.userId, name: 'Alice' }),
 *       ),
 *     }
 *   }
 * }
 * ```
 */
export abstract class AbstractApiController<APIContracts extends Record<string, ApiContract>> {
  protected connections: Map<string, SSESession> = new Map()

  private readonly _roomBroadcaster?: SSERoomBroadcaster
  private readonly _roomManager?: SSERoomManager
  private readonly _connectionSpy?: SSESessionSpy

  constructor(_dependencies: object, sseConfig?: ApiControllerSseConfig) {
    if (sseConfig?.roomBroadcaster) {
      this._roomBroadcaster = sseConfig.roomBroadcaster
      this._roomManager = sseConfig.roomBroadcaster.roomManager
      sseConfig.roomBroadcaster.registerSender((id, msg) => this._sendEvent(id, msg))
    }
    if (sseConfig?.enableConnectionSpy) {
      this._connectionSpy = new SSESessionSpy()
    }
  }

  /**
   * Get the connection spy for testing.
   * Throws if `enableConnectionSpy` was not set in the constructor config.
   */
  public get connectionSpy(): SSESessionSpy {
    if (!this._connectionSpy) {
      throw new Error(
        'Connection spy is not enabled. Pass { enableConnectionSpy: true } to the constructor.',
      )
    }
    return this._connectionSpy
  }

  /**
   * Build and return route handler containers for all routes in this controller.
   *
   * Each key must match a contract key in `APIContracts`.
   * Use `buildApiHandler(contract, handler, options?)` to create each container.
   */
  public abstract buildApiRoutes(): BuildApiRoutesReturnType<APIContracts>

  /**
   * Called by `DIContext.registerRoutes()` to register all routes with Fastify.
   * @returns Array of Fastify `RouteOptions` ready for `app.route()`
   */
  public buildRoutes(): RouteOptions[] {
    const routeHandlers = this.buildApiRoutes()

    if (this._roomManager) {
      const roomContext: ApiRouteInternalRoomContext = {
        roomManager: this._roomManager,
        registerSession: (session) => this.registerConnection(session),
        unregisterSession: (id) => this.unregisterConnection(id),
      }
      return Object.values(routeHandlers).map((handler) =>
        // biome-ignore lint/suspicious/noExplicitAny: Internal dispatch — each handler carries its own contract type
        _buildApiRouteWithRooms(handler as ApiRouteHandler<any>, roomContext),
      )
    }

    return Object.values(routeHandlers).map((handler) =>
      // biome-ignore lint/suspicious/noExplicitAny: Internal dispatch — each handler carries its own contract type
      buildApiRoute(handler as ApiRouteHandler<any>),
    )
  }

  /**
   * Register an active SSE session.
   * @internal
   */
  public registerConnection(session: SSESession): void {
    this.connections.set(session.id, session)
    this._connectionSpy?.addConnection(session)
  }

  /**
   * Unregister a session, auto-leaving all rooms and cleaning up broadcaster state.
   * Idempotent — safe to call multiple times for the same id.
   * @internal
   */
  public unregisterConnection(connectionId: string): void {
    if (!this.connections.has(connectionId)) return
    this._connectionSpy?.addDisconnection(connectionId)
    this._roomManager?.leaveAll(connectionId)
    this._roomBroadcaster?.cleanupConnection(connectionId)
    this.connections.delete(connectionId)
  }

  /**
   * Get the room manager. Returns undefined if rooms are not enabled.
   * @internal
   */
  public get _internalRoomManager(): SSERoomManager | undefined {
    return this._roomManager
  }

  /**
   * Get the room broadcaster. Returns undefined if rooms are not enabled.
   * @internal
   */
  public get _internalRoomBroadcaster(): SSERoomBroadcaster | undefined {
    return this._roomBroadcaster
  }

  public closeConnection(connectionId: string): boolean {
    const session = this.connections.get(connectionId)
    if (!session) {
      return false
    }

    try {
      session.reply.sse.close()
    } catch {
      // Connection may already be closed
    }
    this.unregisterConnection(connectionId)
    return true
  }

  public closeAllConnections(): void {
    const connectionIds = Array.from(this.connections.keys())
    for (const id of connectionIds) {
      this.closeConnection(id)
    }
  }

  private async _sendEvent(connectionId: string, message: SSEMessage): Promise<boolean> {
    const session = this.connections.get(connectionId)
    if (!session) return false
    try {
      const sseReply = session.reply as SSEReply
      await sseReply.sse.send({
        data: message.data,
        event: message.event,
        id: message.id,
        retry: message.retry,
      })
      return true
    } catch {
      this.unregisterConnection(connectionId)
      return false
    }
  }
}
