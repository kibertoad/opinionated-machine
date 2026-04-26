import type { ApiControllerSseConfig } from '../../../lib/api-contracts/AbstractApiController.ts'
import { AbstractApiController, buildApiHandler } from '../../../lib/api-contracts/index.ts'
import {
  apiCreateUserContract,
  apiFeedContract,
  apiGetUserContract,
  apiRoomStreamContract,
} from './testContracts.ts'

// ============================================================================
// Non-SSE + dual-mode controller
// ============================================================================

type TestApiContracts = {
  getUser: typeof apiGetUserContract
  createUser: typeof apiCreateUserContract
  feed: typeof apiFeedContract
}

export class TestApiController extends AbstractApiController<TestApiContracts> {
  public buildApiRoutes() {
    return {
      getUser: buildApiHandler(apiGetUserContract, async (request) => ({
        id: request.params.userId,
        name: 'Alice',
      })),

      createUser: buildApiHandler(apiCreateUserContract, async (request, reply) => {
        reply.code(201)
        return { id: '1', name: request.body.name }
      }),

      feed: buildApiHandler(apiFeedContract, {
        nonSse: async (request) => ({
          id: 'summary',
          name: `limit=${request.query.limit ?? 'none'}`,
        }),
        sse: async (_request, sse) => {
          const session = sse.start('autoClose')
          await session.send('update', { value: 42 })
        },
      }),
    }
  }
}

// ============================================================================
// Rooms controller
// ============================================================================

type TestApiRoomContracts = {
  roomStream: typeof apiRoomStreamContract
}

export class TestApiRoomController extends AbstractApiController<TestApiRoomContracts> {
  constructor(deps: object, sseConfig?: ApiControllerSseConfig) {
    super(deps, sseConfig)
  }

  public buildApiRoutes() {
    return {
      roomStream: buildApiHandler(apiRoomStreamContract, async (request, sse) => {
        const { roomId } = request.params
        const session = sse.start('keepAlive')
        session.rooms.join(roomId)
      }),
    }
  }

  // Test helpers

  public testGetConnectionsInRoom(room: string): string[] {
    return this._internalRoomBroadcaster?.getConnectionsInRoom(room) ?? []
  }

  public testGetConnectionCountInRoom(room: string): number {
    return this._internalRoomBroadcaster?.getConnectionCountInRoom(room) ?? 0
  }

  public testJoinRoom(connectionId: string, room: string | string[]): void {
    this._internalRoomManager?.join(connectionId, room)
  }

  public testLeaveRoom(connectionId: string, room: string | string[]): void {
    this._internalRoomManager?.leave(connectionId, room)
  }

  public async testBroadcastToRoom(
    room: string | string[],
    eventName: 'message',
    data: { from: string; text: string },
  ): Promise<number> {
    if (!this._internalRoomBroadcaster) return 0
    return this._internalRoomBroadcaster.broadcastMessage(room, { event: eventName, data })
  }

  public get testRoomsEnabled(): boolean {
    return this._internalRoomManager !== undefined
  }
}
