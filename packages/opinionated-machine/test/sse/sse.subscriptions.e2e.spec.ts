import { createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type CreateSSESessionSpyResult,
  createSSESessionSpy,
  DIContext,
  SSEHttpClient,
} from '../../index.js'
import { createSSETestServer, type SSETestServerWithResources } from '../sseTestServerFactory.js'
import {
  MockPreferencesService,
  MockProjectService,
  type SubscriptionStreamController,
  SubscriptionTestModule,
  type SubscriptionTestModuleControllers,
  type SubscriptionTestModuleDependencies,
} from './fixtures/subscriptionFixtures.js'

type TestCradle = SubscriptionTestModuleDependencies & SubscriptionTestModuleControllers

const STREAM_PATH = '/api/subscriptions/stream'

/**
 * SSESubscriptionManager wired to a `buildApiRoute` SSE route over real HTTP.
 * The resolver pipeline itself is covered by SSESubscriptionManager.spec.ts;
 * these tests cover the wiring: user context read from the real request, rooms
 * joined by the manager reaching the api-route session, the pre-delivery filter
 * applied to actual sends, and cleanup through the route's onClose hook.
 */
describe('SSE Subscriptions E2E (buildApiRoute)', () => {
  let server: SSETestServerWithResources<undefined>
  let context: DIContext<TestCradle, object>
  let controller: SubscriptionStreamController
  let spy: CreateSSESessionSpyResult['spy']
  let projectService: MockProjectService
  let preferencesService: MockPreferencesService
  let openClients: SSEHttpClient[]

  const connect = async (userId: string) => {
    // The spy is notified once onConnect settles, i.e. after handleConnect has
    // resolved the user context and joined the resolver rooms.
    const result = await SSEHttpClient.connect(server.baseUrl, STREAM_PATH, {
      query: { userId },
      awaitServerConnection: { spy },
    })
    openClients.push(result.client)
    return result
  }

  beforeEach(async () => {
    openClients = []
    projectService = new MockProjectService()
    preferencesService = new MockPreferencesService()
    const sessionSpy = createSSESessionSpy()
    spy = sessionSpy.spy

    context = new DIContext<TestCradle, object>(
      createContainer<TestCradle>({ injectionMode: 'PROXY' }),
      {},
      {},
    )
    context.registerDependencies(
      {
        modules: [
          new SubscriptionTestModule({
            projectService,
            preferencesService,
            hooksDecorator: sessionSpy.withSpy,
          }),
        ],
      },
      undefined,
    )
    controller = context.diContainer.resolve('subscriptionStreamController')

    server = await createSSETestServer((app) => context.registerRoutes(app), {
      configureApp: (app) => {
        app.setValidatorCompiler(validatorCompiler)
        app.setSerializerCompiler(serializerCompiler)
      },
    })
  })

  afterEach(async () => {
    for (const client of openClients) {
      client.close()
    }
    await context.destroy()
    await server.close()
  })

  it(
    'resolves the user from the request and delivers published events to their project room',
    { timeout: 10000 },
    async () => {
      projectService.setMemberships('user-1', ['project-A'])

      const { client, serverConnection } = await connect('user-1')

      const ctx = controller.subscriptionManager.getConnectionContext(serverConnection.id)
      expect(ctx?.userContext.userId).toBe('user-1')
      expect(ctx?.rooms).toEqual(new Set(['project:project-A']))

      const eventsPromise = client.collectEvents(1, 5000)
      const result = await controller.subscriptionManager.publish({
        eventName: 'announcement',
        data: { message: 'New feature!' },
        targetRooms: ['project:project-A'],
        metadata: { scope: 'project', projectId: 'project-A' },
      })
      expect(result).toEqual({ delivered: 1, filtered: 0 })

      const events = await eventsPromise
      expect(events[0]!.event).toBe('announcement')
      expect(JSON.parse(events[0]!.data)).toEqual({ message: 'New feature!' })
    },
  )

  it(
    'withholds an event from a room member whose resolver denies it',
    { timeout: 10000 },
    async () => {
      projectService.setMemberships('member-1', ['project-A'])
      projectService.setMemberships('member-2', ['project-A'])
      preferencesService.setMutedTypes('member-2', ['announcement'])

      const member1 = await connect('member-1')
      const member2 = await connect('member-2')

      const member1Events = member1.client.collectEvents(2, 5000)
      const member2Events = member2.client.collectEvents(1, 5000)

      const announcement = await controller.subscriptionManager.publish({
        eventName: 'announcement',
        data: { message: 'Mixed delivery' },
        targetRooms: ['project:project-A'],
        metadata: { scope: 'project', projectId: 'project-A' },
      })
      expect(announcement).toEqual({ delivered: 1, filtered: 1 })

      // Not muted for either member: marks that anything before it was received.
      const update = await controller.subscriptionManager.publish({
        eventName: 'update',
        data: { entity: 'project', action: 'renamed' },
        targetRooms: ['project:project-A'],
        metadata: { scope: 'project', projectId: 'project-A' },
      })
      expect(update).toEqual({ delivered: 2, filtered: 0 })

      expect((await member1Events).map((e) => e.event)).toEqual(['announcement', 'update'])
      expect((await member2Events).map((e) => e.event)).toEqual(['update'])
    },
  )

  it(
    'starts delivering to a user added to a project once they are refreshed',
    { timeout: 10000 },
    async () => {
      projectService.setMemberships('user-5', [])

      const { client, serverConnection } = await connect('user-5')

      const before = await controller.subscriptionManager.publish({
        eventName: 'announcement',
        data: { message: 'Before membership' },
        targetRooms: ['project:project-A'],
        metadata: { scope: 'project', projectId: 'project-A' },
      })
      expect(before).toEqual({ delivered: 0, filtered: 0 })

      projectService.setMemberships('user-5', ['project-A'])
      await controller.subscriptionManager.refreshUser('user-5')

      expect(
        controller.subscriptionManager.getConnectionContext(serverConnection.id)?.rooms,
      ).toEqual(new Set(['project:project-A']))

      const eventsPromise = client.collectEvents(1, 5000)
      const after = await controller.subscriptionManager.publish({
        eventName: 'announcement',
        data: { message: 'After membership' },
        targetRooms: ['project:project-A'],
        metadata: { scope: 'project', projectId: 'project-A' },
      })
      expect(after).toEqual({ delivered: 1, filtered: 0 })

      const events = await eventsPromise
      expect(JSON.parse(events[0]!.data)).toEqual({ message: 'After membership' })
    },
  )

  it(
    'drops the subscription and its rooms when the client disconnects',
    { timeout: 10000 },
    async () => {
      projectService.setMemberships('user-7', ['project-A'])

      const { client, serverConnection } = await connect('user-7')
      const broadcaster = context.diContainer.resolve('sseRoomBroadcaster')
      expect(broadcaster.getConnectionCountInRoom('project:project-A')).toBe(1)

      client.close()
      // The spy is notified once the route's onClose (handleDisconnect) settles.
      await spy.waitForDisconnection(serverConnection.id)
      expect(
        controller.subscriptionManager.getConnectionContext(serverConnection.id),
      ).toBeUndefined()

      // handleDisconnect only drops the manager's state; the rooms are left by
      // the `sseRooms` wiring, which runs after the route's own onClose.
      await vi.waitFor(() => {
        expect(broadcaster.getConnectionCountInRoom('project:project-A')).toBe(0)
      })

      const result = await controller.subscriptionManager.publish({
        eventName: 'announcement',
        data: { message: 'Anyone there?' },
        targetRooms: ['project:project-A'],
        metadata: { scope: 'project', projectId: 'project-A' },
      })
      expect(result).toEqual({ delivered: 0, filtered: 0 })
    },
  )
})
