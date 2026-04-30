import { asValue, createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  AbstractModule,
  AbstractSSEController,
  asSingletonClass,
  asSSEControllerClass,
  type BuildFastifySSERoutesReturnType,
  buildHandler,
  type DependencyInjectionOptions,
  DIContext,
  defineEvent,
  defineRoom,
  type InferModuleDependencies,
  type MandatoryNameAndRegistrationPair,
  SSEHttpClient,
  SSERoomBroadcaster,
  SSERoomManager,
} from '../../index.js'
import { createSSETestServer, type SSETestServerWithResources } from '../sseTestServerFactory.js'
import { roomStreamContract } from './fixtures/testContracts.js'

// ============================================================================
// Room Name Resolvers
// ============================================================================

const chatRoom = defineRoom<{ roomId: string }>(({ roomId }) => `chat:${roomId}`)

// ============================================================================
// Event Definitions (type-safe, schema-validated)
// ============================================================================

const messageEvent = defineEvent('message', z.object({ from: z.string(), text: z.string() }))
const userJoinedEvent = defineEvent('userJoined', z.object({ userId: z.string() }))

// ============================================================================
// Contracts
// ============================================================================

type BroadcasterTestContracts = {
  roomStream: typeof roomStreamContract
}

// ============================================================================
// Controller
// ============================================================================

class BroadcasterTestController extends AbstractSSEController<BroadcasterTestContracts> {
  public static contracts = {
    roomStream: roomStreamContract,
  } as const

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<BroadcasterTestContracts> {
    return {
      roomStream: this.handleRoomStream,
    }
  }

  private handleRoomStream = buildHandler(roomStreamContract, {
    sse: (request, sse) => {
      const { roomId } = request.params
      const userId = request.query.userId ?? 'anonymous'
      const connection = sse.start('keepAlive', { context: { userId, roomId } })
      connection.rooms.join(chatRoom({ roomId }))
    },
  })
}

// ============================================================================
// Domain Service — depends on SSERoomBroadcaster, NOT the controller
// ============================================================================

class TestDomainService {
  private readonly broadcaster: SSERoomBroadcaster

  constructor(deps: {
    sseRoomBroadcaster: SSERoomBroadcaster
  }) {
    this.broadcaster = deps.sseRoomBroadcaster
  }

  sendMessage(roomId: string, from: string, text: string): Promise<number> {
    return this.broadcaster.broadcastToRoom(
      chatRoom({ roomId }),
      messageEvent,
      { from, text },
      { local: true },
    )
  }

  notifyUserJoined(roomId: string, userId: string): Promise<number> {
    return this.broadcaster.broadcastToRoom(
      chatRoom({ roomId }),
      userJoinedEvent,
      { userId },
      { local: true },
    )
  }

  getViewerCount(roomId: string): number {
    return this.broadcaster.getConnectionCountInRoom(chatRoom({ roomId }))
  }

  getViewerIds(roomId: string): string[] {
    return this.broadcaster.getConnectionsInRoom(chatRoom({ roomId }))
  }
}

// ============================================================================
// Module — room infra registered in resolveDependencies, shared via DI
// ============================================================================

class BroadcasterTestModule extends AbstractModule {
  resolveDependencies() {
    return {
      sseRoomManager: asValue(new SSERoomManager()),
      sseRoomBroadcaster: asSingletonClass(SSERoomBroadcaster),
      domainService: asSingletonClass(TestDomainService),
    }
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      broadcasterTestController: asSSEControllerClass(BroadcasterTestController, {
        diOptions,
        rooms: true,
      }),
    }
  }
}

// Infer types from module — no hand-written dependency/controller types
type ModuleDeps = InferModuleDependencies<BroadcasterTestModule>
type ContainerDeps = ModuleDeps & { broadcasterTestController: BroadcasterTestController }

// ============================================================================
// Tests
// ============================================================================

describe('SSERoomBroadcaster integration', () => {
  let server: SSETestServerWithResources<{
    context: DIContext<ContainerDeps, object>
  }>
  let context: DIContext<ContainerDeps, object>
  let controller: BroadcasterTestController
  let domainService: TestDomainService

  beforeEach(async () => {
    const container = createContainer<ContainerDeps>({
      injectionMode: 'PROXY',
    })
    context = new DIContext<ContainerDeps, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new BroadcasterTestModule()] }, undefined)

    controller = context.diContainer.resolve('broadcasterTestController')
    domainService = context.diContainer.resolve('domainService')

    server = await createSSETestServer(
      (app) => {
        context.registerSSERoutes(app)
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
      },
    )
  })

  afterEach(async () => {
    await server?.close()
  })

  it(
    'full e2e: client connects, domain service broadcasts via defineEvent, client receives event',
    { timeout: 10000 },
    async () => {
      // 1. Client connects to a room
      const { client, serverConnection } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/rooms/my-room/stream',
        {
          query: { userId: 'alice' },
          awaitServerConnection: { controller },
        },
      )

      // 2. Start collecting events on the client side BEFORE broadcasting
      const eventsPromise = client.collectEvents(2, 5000)

      // 3. Domain service broadcasts two events via the shared defineEvent resolver
      await domainService.sendMessage('my-room', 'system', 'Welcome!')
      await domainService.notifyUserJoined('my-room', 'bob')

      // 4. Client receives both events with correct data
      const events = await eventsPromise
      expect(events).toHaveLength(2)

      expect(events[0]?.event).toBe('message')
      expect(JSON.parse(events[0]!.data)).toEqual({ from: 'system', text: 'Welcome!' })

      expect(events[1]?.event).toBe('userJoined')
      expect(JSON.parse(events[1]!.data)).toEqual({ userId: 'bob' })

      client.close()
      await controller.connectionSpy.waitForDisconnection(serverConnection.id)
    },
  )

  it('domain service can broadcast to room via broadcaster', { timeout: 10000 }, async () => {
    const { client, serverConnection } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/rooms/test-room/stream',
      {
        query: { userId: 'alice' },
        awaitServerConnection: { controller },
      },
    )

    // Domain service broadcasts via the broadcaster (not the controller)
    const sent = await domainService.sendMessage('test-room', 'system', 'Hello room!')
    expect(sent).toBe(1)

    client.close()
    await controller.connectionSpy.waitForDisconnection(serverConnection.id)
  })

  it('domain service can use different event types', { timeout: 10000 }, async () => {
    const { client, serverConnection } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/rooms/lobby/stream',
      {
        query: { userId: 'alice' },
        awaitServerConnection: { controller },
      },
    )

    // Type-safe: 'userJoined' event with { userId } data
    const sent = await domainService.notifyUserJoined('lobby', 'bob')
    expect(sent).toBe(1)

    client.close()
    await controller.connectionSpy.waitForDisconnection(serverConnection.id)
  })

  it('domain service can query room membership via broadcaster', { timeout: 10000 }, async () => {
    const { client: client1, serverConnection: conn1 } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/rooms/dashboard-1/stream',
      {
        query: { userId: 'alice' },
        awaitServerConnection: { controller },
      },
    )

    const { client: client2, serverConnection: conn2 } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/rooms/dashboard-1/stream',
      {
        query: { userId: 'bob' },
        awaitServerConnection: { controller },
      },
    )

    // Domain service queries room membership via broadcaster
    expect(domainService.getViewerCount('dashboard-1')).toBe(2)
    expect(domainService.getViewerIds('dashboard-1')).toContain(conn1.id)

    // After one disconnects, count updates
    client1.close()
    await controller.connectionSpy.waitForDisconnection(conn1.id)

    expect(domainService.getViewerCount('dashboard-1')).toBe(1)

    client2.close()
    await controller.connectionSpy.waitForDisconnection(conn2.id)
  })

  it(
    'domain service can broadcast to multiple rooms with deduplication',
    { timeout: 10000 },
    async () => {
      const { client: client1, serverConnection: conn1 } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/rooms/room-a/stream',
        {
          query: { userId: 'alice' },
          awaitServerConnection: { controller },
        },
      )

      // Manually join conn1 to room-b as well (simulates being in multiple rooms)
      controller._internalRoomManager!.join(conn1.id, chatRoom({ roomId: 'room-b' }))

      // Connect another client only to room-b
      const { client: client2, serverConnection: conn2 } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/rooms/room-b/stream',
        {
          query: { userId: 'bob' },
          awaitServerConnection: { controller },
        },
      )

      // Broadcast to both rooms via broadcaster — conn1 should receive only once
      const result = await controller.roomBroadcaster.broadcastMessage(
        [chatRoom({ roomId: 'room-a' }), chatRoom({ roomId: 'room-b' })],
        { event: 'message', data: { from: 'system', text: 'Multi-room announcement' } },
        { local: true },
      )
      // conn1 is in both rooms but counted once, conn2 is in room-b
      expect(result.delivered).toBe(2)

      client1.close()
      client2.close()
      await controller.connectionSpy.waitForDisconnection(conn1.id)
      await controller.connectionSpy.waitForDisconnection(conn2.id)
    },
  )

  it('roomBroadcaster getter throws when rooms are not enabled', () => {
    const noRoomController = new BroadcasterNoRoomController({})
    expect(() => noRoomController.roomBroadcaster).toThrow('Rooms are not enabled')
  })

  it('broadcaster is the same singleton instance from controller and DI', () => {
    const fromController = controller.roomBroadcaster
    const fromDI = context.diContainer.resolve('sseRoomBroadcaster')
    expect(fromDI).toBe(fromController)
  })
})

// Helper controller without rooms for the "throws" test
class BroadcasterNoRoomController extends AbstractSSEController<BroadcasterTestContracts> {
  public static contracts = { roomStream: roomStreamContract } as const

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<BroadcasterTestContracts> {
    return {
      roomStream: buildHandler(roomStreamContract, {
        sse: (_request, sse) => {
          sse.start('autoClose')
        },
      }),
    }
  }
}
