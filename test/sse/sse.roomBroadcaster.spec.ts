import { asFunction, createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AbstractModule,
  AbstractSSEController,
  asSingletonFunction,
  type BuildFastifySSERoutesReturnType,
  buildHandler,
  type DependencyInjectionOptions,
  DIContext,
  defineRoom,
  type MandatoryNameAndRegistrationPair,
  type SSEControllerConfig,
  SSEHttpClient,
  type SSERoomBroadcaster,
  SSETestServer,
} from '../../index.js'
import { roomStreamContract } from './fixtures/testContracts.js'

// ============================================================================
// Room Name Resolvers
// ============================================================================

const chatRoom = defineRoom<{ roomId: string }>(({ roomId }) => `chat:${roomId}`)

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

  constructor(deps: object, sseConfig?: SSEControllerConfig) {
    super(deps, {
      ...sseConfig,
      rooms: sseConfig?.rooms ?? {},
    })
  }

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
  private readonly broadcaster: SSERoomBroadcaster<BroadcasterTestContracts>

  constructor(deps: {
    roomBroadcaster: SSERoomBroadcaster<BroadcasterTestContracts>
  }) {
    this.broadcaster = deps.roomBroadcaster
  }

  sendMessage(roomId: string, from: string, text: string): Promise<number> {
    return this.broadcaster.broadcastToRoom(
      chatRoom({ roomId }),
      'message',
      { from, text },
      { local: true },
    )
  }

  notifyUserJoined(roomId: string, userId: string): Promise<number> {
    return this.broadcaster.broadcastToRoom(
      chatRoom({ roomId }),
      'userJoined',
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
// Module — wires controller, broadcaster, and domain service together
//
// Key insight: roomBroadcaster goes in resolveDependencies(), NOT resolveControllers().
// resolveControllers() only registers entries with isSSEController/isDualModeController
// flags in the DI container; other entries are treated as REST controller resolvers.
// ============================================================================

type BroadcasterTestModuleDependencies = {
  roomBroadcaster: SSERoomBroadcaster<BroadcasterTestContracts>
  domainService: TestDomainService
}

type BroadcasterTestModuleControllers = {
  broadcasterTestController: BroadcasterTestController
}

class BroadcasterTestModule extends AbstractModule<BroadcasterTestModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<BroadcasterTestModuleDependencies> {
    return {
      // Broadcaster extracted from controller — registered as a dependency, not a controller
      roomBroadcaster: asSingletonFunction(
        (cradle: BroadcasterTestModuleControllers) =>
          cradle.broadcasterTestController.roomBroadcaster,
      ),
      domainService: asSingletonFunction(
        (cradle: BroadcasterTestModuleDependencies) => new TestDomainService(cradle),
      ),
    }
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    const enableConnectionSpy = diOptions.isTestMode ?? false
    const sseConfig: SSEControllerConfig = {
      ...(enableConnectionSpy && { enableConnectionSpy: true }),
    }

    return {
      broadcasterTestController: asFunction(
        (cradle: object) => new BroadcasterTestController(cradle, sseConfig),
        {
          lifetime: 'SINGLETON',
          isSSEController: true,
          asyncDispose: 'closeAllConnections',
          asyncDisposePriority: 5,
        },
      ),
    }
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('SSERoomBroadcaster integration', () => {
  let server: SSETestServer<{
    context: DIContext<BroadcasterTestModuleControllers, object>
  }>
  let context: DIContext<BroadcasterTestModuleControllers, object>
  let controller: BroadcasterTestController
  let domainService: TestDomainService

  beforeEach(async () => {
    const container = createContainer<
      BroadcasterTestModuleControllers & BroadcasterTestModuleDependencies
    >({
      injectionMode: 'PROXY',
    })
    context = new DIContext<BroadcasterTestModuleControllers, object>(
      container,
      { isTestMode: true },
      {},
    )
    context.registerDependencies({ modules: [new BroadcasterTestModule()] }, undefined)

    controller = context.diContainer.resolve<BroadcasterTestController>('broadcasterTestController')
    domainService = context.diContainer.resolve<TestDomainService>('domainService')

    server = await SSETestServer.create(
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
      controller._internalRoomManager!.join(conn1.id, 'room-b')

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
      const sent = await controller.roomBroadcaster.broadcastToRoom(
        ['room-a', 'room-b'],
        'message',
        { from: 'system', text: 'Multi-room announcement' },
        { local: true },
      )
      // conn1 is in both rooms but counted once, conn2 is in room-b
      expect(sent).toBe(2)

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
    const fromDI =
      context.diContainer.resolve<SSERoomBroadcaster<BroadcasterTestContracts>>('roomBroadcaster')
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
