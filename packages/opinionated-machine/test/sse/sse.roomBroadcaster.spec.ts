import { defineApiContract, sseBody } from '@lokalise/api-contracts'
import { asValue, createContainer } from 'awilix'
import type { RouteOptions } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import {
  AbstractApiController,
  AbstractModule,
  asApiControllerClass,
  asSingletonClass,
  buildApiRoute,
  createSSESessionSpy,
  DIContext,
  defineEvent,
  defineRoom,
  getSessionRooms,
  type InferModuleDependencies,
  type MandatoryNameAndRegistrationPair,
  SSEHttpClient,
  SSERoomBroadcaster,
  SSERoomManager,
} from '../../index.js'
import { createSSETestServer, type SSETestServerWithResources } from '../sseTestServerFactory.js'

/**
 * The DI wiring the README recommends for rooms: `sseRoomManager` and
 * `sseRoomBroadcaster` registered once in a module, an api controller opting
 * its route into rooms with the injected broadcaster, and a domain service that
 * depends on the broadcaster alone (not on the controller) pushing events to
 * the controller's sessions.
 */

const chatRoom = defineRoom<{ roomId: string }>(({ roomId }) => `chat:${roomId}`)

const messageEvent = defineEvent('message', z.object({ from: z.string(), text: z.string() }))
const userJoinedEvent = defineEvent('userJoined', z.object({ userId: z.string() }))

const chatStreamContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Chat room stream',
  pathResolver: ({ roomId }) => `/api/chat/${roomId}/stream`,
  requestPathParamsSchema: z.object({ roomId: z.string() }),
  responsesByStatusCode: {
    200: {
      content: {
        'text/event-stream': sseBody({
          message: messageEvent.schema,
          userJoined: userJoinedEvent.schema,
        }),
      },
    },
  },
})

const { spy, withSpy } = createSSESessionSpy()

class ChatController extends AbstractApiController<typeof ChatController.contracts> {
  public static contracts = { chatStream: chatStreamContract } as const

  readonly routes: Record<keyof typeof ChatController.contracts, RouteOptions>

  constructor({ sseRoomBroadcaster }: { sseRoomBroadcaster: SSERoomBroadcaster }) {
    super()
    this.routes = {
      chatStream: buildApiRoute(
        chatStreamContract,
        (request, _reply, { sse }) => {
          const session = sse.start('keepAlive')
          getSessionRooms(session).join(chatRoom({ roomId: request.params.roomId }))
        },
        { ...withSpy(), sseRooms: sseRoomBroadcaster },
      ),
    }
  }
}

class ChatService {
  private readonly broadcaster: SSERoomBroadcaster

  constructor({ sseRoomBroadcaster }: { sseRoomBroadcaster: SSERoomBroadcaster }) {
    this.broadcaster = sseRoomBroadcaster
  }

  sendMessage(roomId: string, from: string, text: string): Promise<number> {
    return this.broadcaster.broadcastToRoom(chatRoom({ roomId }), messageEvent, { from, text })
  }

  notifyUserJoined(roomId: string, userId: string): Promise<number> {
    return this.broadcaster.broadcastToRoom(chatRoom({ roomId }), userJoinedEvent, { userId })
  }
}

class ChatModule extends AbstractModule {
  resolveDependencies() {
    return {
      sseRoomManager: asValue(new SSERoomManager()),
      sseRoomBroadcaster: asSingletonClass(SSERoomBroadcaster),
      chatService: asSingletonClass(ChatService),
    }
  }

  override resolveControllers(): MandatoryNameAndRegistrationPair<unknown> {
    return {
      chatController: asApiControllerClass(ChatController),
    }
  }
}

type ContainerDeps = InferModuleDependencies<ChatModule> & { chatController: ChatController }

describe('SSERoomBroadcaster via DI', () => {
  let context: DIContext<ContainerDeps, object>
  let server: SSETestServerWithResources<undefined>

  beforeEach(async () => {
    context = new DIContext<ContainerDeps, object>(
      createContainer<ContainerDeps>({ injectionMode: 'PROXY' }),
      {},
      {},
    )
    context.registerDependencies({ modules: [new ChatModule()] }, undefined)

    server = await createSSETestServer((app) => context.registerRoutes(app), {
      configureApp: (app) => {
        app.setValidatorCompiler(validatorCompiler)
        app.setSerializerCompiler(serializerCompiler)
      },
      setup: () => undefined,
    })
  })

  afterEach(async () => {
    await server.close()
    await context.destroy()
  })

  it(
    "delivers a domain service's broadcasts to a controller route's sessions",
    { timeout: 10000 },
    async () => {
      const chatService = context.diContainer.resolve('chatService')
      const { client } = await SSEHttpClient.connect(server.baseUrl, '/api/chat/my-room/stream', {
        awaitServerConnection: { spy },
      })
      const eventsPromise = client.collectEvents(2, 5000)

      expect(await chatService.sendMessage('my-room', 'system', 'Welcome!')).toBe(1)
      expect(await chatService.notifyUserJoined('my-room', 'bob')).toBe(1)

      const events = await eventsPromise
      expect(events.map((event) => [event.event, JSON.parse(event.data)])).toEqual([
        ['message', { from: 'system', text: 'Welcome!' }],
        ['userJoined', { userId: 'bob' }],
      ])

      client.close()
    },
  )
})
