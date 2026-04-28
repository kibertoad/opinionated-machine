import { AbstractApiController, buildApiHandler } from '../../../lib/api-contracts/index.ts'
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

type TestApiContracts = {
  getUser: typeof apiGetUserContract
  createUser: typeof apiCreateUserContract
  feed: typeof apiFeedContract
}

export class TestApiController extends AbstractApiController<TestApiContracts> {
  public buildApiRoutes() {
    return {
      getUser: buildApiHandler(apiGetUserContract, async (request) => ({
        status: 200,
        body: { id: request.params.userId, name: 'Alice' },
      })),

      createUser: buildApiHandler(apiCreateUserContract, (request) => ({
        status: 201,
        body: { id: '1', name: request.body.name },
      })),

      feed: buildApiHandler(apiFeedContract, {
        nonSse: async (request) => ({
          status: 200,
          body: { id: 'summary', name: `limit=${request.query.limit ?? 'none'}` },
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
  public buildApiRoutes() {
    return {
      roomStream: buildApiHandler(apiRoomStreamContract, (request, sse) => {
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
    return await this._internalRoomBroadcaster.broadcastMessage(room, { event: eventName, data })
  }

  public get testRoomsEnabled(): boolean {
    return this._internalRoomManager !== undefined
  }
}

// ============================================================================
// Error-path controller
// ============================================================================

type TestApiErrorContracts = {
  sseRespond: typeof apiSseRespondContract
  sseNoStart: typeof apiSseNoStartContract
  ssePreError: typeof apiSsePreErrorContract
  ssePostError: typeof apiSsePostErrorContract
  validationFail: typeof apiValidationFailContract
  headerSuccess: typeof apiHeaderSuccessContract
  headerFail: typeof apiHeaderFailContract
}

export class TestApiErrorController extends AbstractApiController<TestApiErrorContracts> {
  public buildApiRoutes() {
    return {
      sseRespond: buildApiHandler(apiSseRespondContract, (_request, sse) => {
        sse.respond(404, { error: 'not found' })
      }),

      sseNoStart: buildApiHandler(apiSseNoStartContract, () => {
        // intentionally does nothing — exercises the no-start/no-respond error path
      }),

      ssePreError: buildApiHandler(apiSsePreErrorContract, () => {
        throw Object.assign(new Error('pre-start error'), { httpStatusCode: 422 })
      }),

      ssePostError: buildApiHandler(apiSsePostErrorContract, (_request, sse) => {
        sse.start('autoClose')
        throw new Error('post-start error')
      }),

      validationFail: buildApiHandler(apiValidationFailContract, () => ({
        status: 200,
        body: { value: 123 as unknown as string },
      })),

      headerSuccess: buildApiHandler(apiHeaderSuccessContract, (_request, reply) => {
        reply.header('x-api-version', '1.0')
        return { status: 200, body: { ok: true } }
      }),

      headerFail: buildApiHandler(apiHeaderFailContract, () => ({
        status: 200,
        body: { ok: true },
      })),
    }
  }
}
