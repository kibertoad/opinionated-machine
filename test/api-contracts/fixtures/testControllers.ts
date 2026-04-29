import { AbstractApiController, buildApiRoute } from '../../../lib/api-contracts/index.ts'
import type { SSERoomBroadcaster } from '../../../lib/sse/rooms/SSERoomBroadcaster.ts'
import type { SSERoomManager } from '../../../lib/sse/rooms/SSERoomManager.ts'
import {
  apiCreateUserContract,
  apiFeedContract,
  apiGetUserContract,
  apiHeaderFailContract,
  apiHeaderSuccessContract,
  apiRoomStreamContract,
  apiSseNoStartContract,
  apiSsePostErrorContract,
  apiSsePreErrorContract,
  apiSseRespondContract,
  apiValidationFailContract,
} from './testContracts.ts'

// ============================================================================
// Non-SSE + dual-mode controller
// ============================================================================

export class TestApiController extends AbstractApiController {
  readonly routes = [
    buildApiRoute(apiGetUserContract, async (request) => ({
      status: 200,
      body: { id: request.params.userId, name: 'Alice' },
    })),

    buildApiRoute(apiCreateUserContract, (request) => ({
      status: 201,
      body: { id: '1', name: request.body.name },
    })),

    buildApiRoute(apiFeedContract, {
      nonSse: async (request) => ({
        status: 200,
        body: { id: 'summary', name: `limit=${request.query.limit ?? 'none'}` },
      }),
      sse: async (_request, sse) => {
        const session = sse.start('autoClose')
        await session.send('update', { value: 42 })
      },
    }),
  ]
}

// ============================================================================
// Rooms controller
// ============================================================================

export class TestApiRoomController extends AbstractApiController {
  private readonly roomManager: SSERoomManager
  private readonly roomBroadcaster: SSERoomBroadcaster

  constructor(deps: { sseRoomManager: SSERoomManager; sseRoomBroadcaster: SSERoomBroadcaster }) {
    super()
    this.roomManager = deps.sseRoomManager
    this.roomBroadcaster = deps.sseRoomBroadcaster
  }

  readonly routes = [
    buildApiRoute(apiRoomStreamContract, (_request, sse) => {
      sse.start('keepAlive')
    }),
  ]

  // Test helpers

  public testGetConnectionsInRoom(room: string): string[] {
    return this.roomBroadcaster.getConnectionsInRoom(room)
  }

  public testGetConnectionCountInRoom(room: string): number {
    return this.roomBroadcaster.getConnectionCountInRoom(room)
  }

  public testJoinRoom(connectionId: string, room: string | string[]): void {
    this.roomManager.join(connectionId, room)
  }

  public testLeaveRoom(connectionId: string, room: string | string[]): void {
    this.roomManager.leave(connectionId, room)
  }

  public async testBroadcastToRoom(
    room: string | string[],
    eventName: 'message',
    data: { from: string; text: string },
  ): Promise<number> {
    return this.roomBroadcaster.broadcastMessage(room, { event: eventName, data })
  }

  public get testRoomsEnabled(): boolean {
    return true
  }
}

// ============================================================================
// Error-path controller
// ============================================================================

export class TestApiErrorController extends AbstractApiController {
  readonly routes = [
    buildApiRoute(apiSseRespondContract, (_request, sse) => {
      sse.respond(404, { error: 'not found' })
    }),

    buildApiRoute(apiSseNoStartContract, () => {
      // intentionally does nothing — exercises the no-start/no-respond error path
    }),

    buildApiRoute(apiSsePreErrorContract, () => {
      throw Object.assign(new Error('pre-start error'), { httpStatusCode: 422 })
    }),

    buildApiRoute(apiSsePostErrorContract, (_request, sse) => {
      sse.start('autoClose')
      throw new Error('post-start error')
    }),

    buildApiRoute(apiValidationFailContract, () => ({
      status: 200,
      body: { value: 123 as unknown as string },
    })),

    buildApiRoute(apiHeaderSuccessContract, (_request, reply) => {
      reply.header('x-api-version', '1.0')
      return { status: 200, body: { ok: true } }
    }),

    buildApiRoute(apiHeaderFailContract, () => ({
      status: 200,
      body: { ok: true },
    })),
  ]
}
