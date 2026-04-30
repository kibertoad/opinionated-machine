import { createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DIContext, SSEHttpClient } from '../../index.js'
import { createSSETestServer, type SSETestServerWithResources } from '../sseTestServerFactory.js'
import type { SubscriptionStreamController } from './fixtures/subscriptionFixtures.js'
import {
  MockPreferencesService,
  MockProjectService,
  SubscriptionTestModule,
  type SubscriptionTestModuleControllers,
  type SubscriptionTestModuleDependencies,
  type TestEventMetadata,
} from './fixtures/subscriptionFixtures.js'

describe('SSE Subscriptions E2E', () => {
  let server: SSETestServerWithResources<{
    context: DIContext<
      SubscriptionTestModuleDependencies & SubscriptionTestModuleControllers,
      object
    >
  }>
  let context: DIContext<
    SubscriptionTestModuleDependencies & SubscriptionTestModuleControllers,
    object
  >
  let controller: SubscriptionStreamController
  let projectService: MockProjectService
  let preferencesService: MockPreferencesService

  beforeEach(async () => {
    projectService = new MockProjectService()
    preferencesService = new MockPreferencesService()

    const container = createContainer<
      SubscriptionTestModuleDependencies & SubscriptionTestModuleControllers
    >({ injectionMode: 'PROXY' })

    context = new DIContext<
      SubscriptionTestModuleDependencies & SubscriptionTestModuleControllers,
      object
    >(container, { isTestMode: true }, {})

    context.registerDependencies(
      { modules: [new SubscriptionTestModule(projectService, preferencesService)] },
      undefined,
    )

    controller = context.diContainer.resolve<SubscriptionStreamController>(
      'subscriptionStreamController',
    )

    server = await createSSETestServer(
      (app) => {
        context.registerSSERoutes(app)
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ context }),
      },
    )
  })

  afterEach(async () => {
    await context.destroy()
    await server.close()
  })

  describe('project announcements — full scenario', () => {
    it('delivers to project member who has not muted', { timeout: 10000 }, async () => {
      // Setup: user-1 is a member of project-A
      projectService.setMemberships('user-1', ['project-A'])

      const { client, serverConnection } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/subscriptions/stream',
        {
          query: { userId: 'user-1' },
          awaitServerConnection: { controller },
        },
      )

      // awaitServerConnection only waits for sse.start() to register the SSE
      // connection; the SSESubscriptionManager.handleConnect() that fires
      // afterward is async, so we wait for it explicitly here.
      await controller.awaitSubscriptionConnect(serverConnection.id)

      // Verify rooms were joined
      const ctx = controller.subscriptionManager.getConnectionContext(serverConnection.id)
      expect(ctx).toBeDefined()
      expect(ctx!.userContext.projectIds.has('project-A')).toBe(true)
      expect(ctx!.rooms.has('project:project-A')).toBe(true)

      // Publish a project announcement
      const result = await controller.subscriptionManager.publish({
        eventName: 'announcement',
        data: { message: 'New feature!' },
        targetRooms: ['project:project-A'],
        metadata: { scope: 'project', projectId: 'project-A' } as TestEventMetadata,
      })

      expect(result.delivered).toBe(1)
      expect(result.filtered).toBe(0)

      client.close()
    })

    it('filters from project member who muted announcements', { timeout: 10000 }, async () => {
      projectService.setMemberships('user-2', ['project-A'])
      preferencesService.setMutedTypes('user-2', ['announcement'])

      const { client, serverConnection } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/subscriptions/stream',
        {
          query: { userId: 'user-2' },
          awaitServerConnection: { controller },
        },
      )

      await controller.awaitSubscriptionConnect(serverConnection.id)

      const result = await controller.subscriptionManager.publish({
        eventName: 'announcement',
        data: { message: 'New feature!' },
        targetRooms: ['project:project-A'],
        metadata: { scope: 'project', projectId: 'project-A' } as TestEventMetadata,
      })

      expect(result.delivered).toBe(0)
      expect(result.filtered).toBe(1)

      client.close()
    })

    it(
      'filters from non-project-member regardless of mute settings',
      { timeout: 10000 },
      async () => {
        // user-3 is NOT a member of project-A
        projectService.setMemberships('user-3', ['project-B'])

        const { client, serverConnection } = await SSEHttpClient.connect(
          server.baseUrl,
          '/api/subscriptions/stream',
          {
            query: { userId: 'user-3' },
            awaitServerConnection: { controller },
          },
        )

        await controller.awaitSubscriptionConnect(serverConnection.id)

        // user-3 is in project:project-B room, not project:project-A
        // Publishing to project:project-A should not reach user-3
        const result = await controller.subscriptionManager.publish({
          eventName: 'announcement',
          data: { message: 'New feature!' },
          targetRooms: ['project:project-A'],
          metadata: { scope: 'project', projectId: 'project-A' } as TestEventMetadata,
        })

        // user-3 is not even in the target room, so no evaluation happens
        expect(result.delivered).toBe(0)

        client.close()
      },
    )
  })

  describe('mid-connection preference refresh', () => {
    it(
      'user mutes event type mid-connection — stops receiving that event',
      { timeout: 10000 },
      async () => {
        projectService.setMemberships('user-4', ['project-A'])
        // Not muted initially
        preferencesService.setMutedTypes('user-4', [])

        const { client, serverConnection } = await SSEHttpClient.connect(
          server.baseUrl,
          '/api/subscriptions/stream',
          {
            query: { userId: 'user-4' },
            awaitServerConnection: { controller },
          },
        )

        await controller.awaitSubscriptionConnect(serverConnection.id)

        // First publish — should be delivered
        const result1 = await controller.subscriptionManager.publish({
          eventName: 'announcement',
          data: { message: 'First' },
          targetRooms: ['project:project-A'],
          metadata: { scope: 'project', projectId: 'project-A' } as TestEventMetadata,
        })
        expect(result1.delivered).toBe(1)

        // User mutes announcements and refreshes
        preferencesService.setMutedTypes('user-4', ['announcement'])
        await controller.subscriptionManager.refreshUser('user-4')

        // Second publish — should be filtered
        const result2 = await controller.subscriptionManager.publish({
          eventName: 'announcement',
          data: { message: 'Second' },
          targetRooms: ['project:project-A'],
          metadata: { scope: 'project', projectId: 'project-A' } as TestEventMetadata,
        })
        expect(result2.delivered).toBe(0)
        expect(result2.filtered).toBe(1)

        client.close()
      },
    )

    it(
      'user added to project mid-connection — starts receiving project events after refresh',
      { timeout: 10000 },
      async () => {
        // user-5 starts with no project memberships
        projectService.setMemberships('user-5', [])

        const { client, serverConnection } = await SSEHttpClient.connect(
          server.baseUrl,
          '/api/subscriptions/stream',
          {
            query: { userId: 'user-5' },
            awaitServerConnection: { controller },
          },
        )

        await controller.awaitSubscriptionConnect(serverConnection.id)

        // Not in any project room — publish shouldn't reach
        const result1 = await controller.subscriptionManager.publish({
          eventName: 'announcement',
          data: { message: 'Before membership' },
          targetRooms: ['project:project-A'],
          metadata: { scope: 'project', projectId: 'project-A' } as TestEventMetadata,
        })
        expect(result1.delivered).toBe(0)

        // Add user to project and refresh
        projectService.setMemberships('user-5', ['project-A'])
        await controller.subscriptionManager.refreshUser('user-5')

        // Now the user should be in the project:project-A room
        const ctx = controller.subscriptionManager.getConnectionContext(serverConnection.id)
        expect(ctx!.rooms.has('project:project-A')).toBe(true)

        // Publish again — should be delivered
        const result2 = await controller.subscriptionManager.publish({
          eventName: 'announcement',
          data: { message: 'After membership' },
          targetRooms: ['project:project-A'],
          metadata: { scope: 'project', projectId: 'project-A' } as TestEventMetadata,
        })
        expect(result2.delivered).toBe(1)

        client.close()
      },
    )
  })

  describe('multiple users', () => {
    it(
      'delivers to some users and filters from others in the same room',
      { timeout: 10000 },
      async () => {
        // Both users are project-A members
        projectService.setMemberships('member-1', ['project-A'])
        projectService.setMemberships('member-2', ['project-A'])
        // member-2 has muted announcements
        preferencesService.setMutedTypes('member-2', ['announcement'])

        const conn1 = await SSEHttpClient.connect(server.baseUrl, '/api/subscriptions/stream', {
          query: { userId: 'member-1' },
          awaitServerConnection: { controller },
        })

        const conn2 = await SSEHttpClient.connect(server.baseUrl, '/api/subscriptions/stream', {
          query: { userId: 'member-2' },
          awaitServerConnection: { controller },
        })

        await Promise.all([
          controller.awaitSubscriptionConnect(conn1.serverConnection.id),
          controller.awaitSubscriptionConnect(conn2.serverConnection.id),
        ])

        const result = await controller.subscriptionManager.publish({
          eventName: 'announcement',
          data: { message: 'Mixed delivery' },
          targetRooms: ['project:project-A'],
          metadata: { scope: 'project', projectId: 'project-A' } as TestEventMetadata,
        })

        // member-1 should receive, member-2 should be filtered
        expect(result.delivered).toBe(1)
        expect(result.filtered).toBe(1)

        conn1.client.close()
        conn2.client.close()
      },
    )
  })

  describe('type guards in resolvers', () => {
    it(
      'resolver uses defineEventMetadata guards for type-safe metadata narrowing',
      { timeout: 10000 },
      async () => {
        projectService.setMemberships('user-6', ['project-A'])

        const { client, serverConnection } = await SSEHttpClient.connect(
          server.baseUrl,
          '/api/subscriptions/stream',
          {
            query: { userId: 'user-6' },
            awaitServerConnection: { controller },
          },
        )

        await controller.awaitSubscriptionConnect(serverConnection.id)

        // Global event — ProjectMembershipResolver narrows via testMeta.global()
        // and explicitly allows; MutePreferencesResolver defers since the user
        // hasn't muted 'alert'. The connection is in 'project:project-A' so the
        // broadcast reaches it.
        const globalResult = await controller.subscriptionManager.publish({
          eventName: 'alert',
          data: { level: 'info', message: 'System update' },
          targetRooms: ['project:project-A'],
          metadata: { scope: 'global' } as TestEventMetadata,
        })

        expect(globalResult.delivered).toBe(1)
        expect(globalResult.filtered).toBe(0)

        client.close()
      },
    )
  })

  describe('disconnect cleanup', () => {
    it('removes connection state on disconnect', { timeout: 10000 }, async () => {
      projectService.setMemberships('user-7', ['project-A'])

      const { client, serverConnection } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/subscriptions/stream',
        {
          query: { userId: 'user-7' },
          awaitServerConnection: { controller },
        },
      )

      await controller.awaitSubscriptionConnect(serverConnection.id)

      expect(controller.subscriptionManager.getConnectionContext(serverConnection.id)).toBeDefined()

      client.close()

      // The route's onClose runs (and is awaited) before the spy fires the
      // disconnection event, so by the time this resolves, our handleDisconnect
      // has already cleared the manager's state — no sleep needed.
      await controller.connectionSpy.waitForDisconnection(serverConnection.id)

      expect(
        controller.subscriptionManager.getConnectionContext(serverConnection.id),
      ).toBeUndefined()
    })
  })
})
