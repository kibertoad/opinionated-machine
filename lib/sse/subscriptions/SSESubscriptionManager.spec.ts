import { describe, expect, it, vi } from 'vitest'
import { SSERoomBroadcaster } from '../rooms/SSERoomBroadcaster.js'
import { SSERoomManager } from '../rooms/SSERoomManager.js'
import type { SSERoomAdapter } from '../rooms/types.js'
import { SSESubscriptionManager } from './SSESubscriptionManager.js'
import type {
  IncomingEvent,
  SSESubscriptionManagerConfig,
  SubscriptionContext,
  SubscriptionResolver,
} from './types.js'

function createMockAdapter(): SSERoomAdapter {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
  }
}

type TestUserContext = {
  userId: string
  projectIds: Set<string>
  mutedEventTypes: Set<string>
}

type TestMetadata =
  | { scope: 'project'; projectId: string }
  | { scope: 'team'; teamId: string }
  | { scope: 'global' }

function createMockResolver(
  overrides?: Partial<SubscriptionResolver<TestUserContext, TestMetadata>>,
): SubscriptionResolver<TestUserContext, TestMetadata> {
  return {
    name: overrides?.name ?? 'mock-resolver',
    evaluate: vi.fn().mockReturnValue({ action: 'defer' as const }),
    ...overrides,
  }
}

function createMockSession(id?: string) {
  return {
    id: id ?? 'conn-1',
    request: { headers: {} } as any,
  }
}

const defaultResolveUserContext = async () => ({
  userId: 'user-1',
  projectIds: new Set<string>(),
  mutedEventTypes: new Set<string>(),
})

function createTestManager(
  overrides?: Partial<SSESubscriptionManagerConfig<TestUserContext, TestMetadata>>,
) {
  const adapter = createMockAdapter()
  const roomManager = new SSERoomManager({ adapter })
  const sendEvent = vi.fn().mockResolvedValue(true)
  const broadcaster = new SSERoomBroadcaster({ sseRoomManager: roomManager })
  broadcaster.registerSender(sendEvent)

  const manager = new SSESubscriptionManager<TestUserContext, TestMetadata>(
    {
      resolveUserContext: defaultResolveUserContext,
      resolvers: [],
      ...overrides,
    },
    { sseRoomManager: roomManager, sseRoomBroadcaster: broadcaster },
  )

  return { manager, roomManager, broadcaster, sendEvent, adapter }
}

describe('SSESubscriptionManager', () => {
  describe('constructor', () => {
    it('should register pre-delivery filter on broadcaster', async () => {
      const resolver = createMockResolver({
        name: 'test-resolver',
        evaluate: vi.fn().mockReturnValue({ action: 'allow' }),
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-a'],
        }),
      })
      const { manager, sendEvent } = createTestManager({ resolvers: [resolver] })

      const session = createMockSession('conn-1')
      await manager.handleConnect(session)

      // The pre-delivery filter is active — broadcasting triggers shouldDeliver
      const result = await manager.publish({
        eventName: 'test',
        data: { x: 1 },
        targetRooms: ['room-a'],
        metadata: { scope: 'global' } as TestMetadata,
      })

      expect(sendEvent).toHaveBeenCalledTimes(1)
      expect(result.delivered).toBe(1)
    })

    it('should default to deny policy', async () => {
      // All resolvers defer → default policy (deny) applies
      const resolver = createMockResolver({
        name: 'deferred',
        evaluate: vi.fn().mockReturnValue({ action: 'defer' }),
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-a'],
        }),
      })
      const { manager, sendEvent } = createTestManager({ resolvers: [resolver] })

      await manager.handleConnect(createMockSession('conn-1'))

      const result = await manager.publish({
        eventName: 'test',
        data: {},
        targetRooms: ['room-a'],
        metadata: { scope: 'global' } as TestMetadata,
      })

      expect(sendEvent).not.toHaveBeenCalled()
      expect(result.filtered).toBe(1)
      expect(result.delivered).toBe(0)
    })
  })

  describe('handleConnect', () => {
    it('should resolve user context from request', async () => {
      const resolveUserContext = vi.fn().mockResolvedValue({
        userId: 'user-42',
        projectIds: new Set(['p1']),
        mutedEventTypes: new Set(),
      })
      const { manager } = createTestManager({ resolveUserContext })

      const session = createMockSession('conn-1')
      await manager.handleConnect(session)

      expect(resolveUserContext).toHaveBeenCalledWith(session.request)
      const ctx = manager.getConnectionContext('conn-1')
      expect(ctx!.userContext.userId).toBe('user-42')
    })

    it('should call onConnect on each resolver in order', async () => {
      const callOrder: string[] = []
      const resolver1 = createMockResolver({
        name: 'resolver-1',
        onConnect: vi.fn().mockImplementation(() => {
          callOrder.push('resolver-1')
          return {
            userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
            rooms: [],
          }
        }),
      })
      const resolver2 = createMockResolver({
        name: 'resolver-2',
        onConnect: vi.fn().mockImplementation(() => {
          callOrder.push('resolver-2')
          return {
            userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
            rooms: [],
          }
        }),
      })

      const { manager } = createTestManager({ resolvers: [resolver1, resolver2] })
      await manager.handleConnect(createMockSession())

      expect(callOrder).toEqual(['resolver-1', 'resolver-2'])
    })

    it('should join union of all resolver-declared rooms', async () => {
      const resolver1 = createMockResolver({
        name: 'r1',
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-a', 'room-b'],
        }),
      })
      const resolver2 = createMockResolver({
        name: 'r2',
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-c'],
        }),
      })

      const { manager, roomManager } = createTestManager({ resolvers: [resolver1, resolver2] })
      await manager.handleConnect(createMockSession('conn-1'))

      expect(roomManager.getRooms('conn-1').sort()).toEqual(['room-a', 'room-b', 'room-c'])
    })

    it('should deduplicate rooms across resolvers', async () => {
      const resolver1 = createMockResolver({
        name: 'r1',
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-a', 'room-b'],
        }),
      })
      const resolver2 = createMockResolver({
        name: 'r2',
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-b', 'room-c'],
        }),
      })

      const { manager } = createTestManager({ resolvers: [resolver1, resolver2] })
      await manager.handleConnect(createMockSession('conn-1'))

      const ctx = manager.getConnectionContext('conn-1')
      expect(ctx!.rooms.size).toBe(3)
      expect(ctx!.rooms.has('room-a')).toBe(true)
      expect(ctx!.rooms.has('room-b')).toBe(true)
      expect(ctx!.rooms.has('room-c')).toBe(true)
    })

    it('should build context with accumulated rooms from all resolvers', async () => {
      const resolver1 = createMockResolver({
        name: 'r1',
        onConnect: vi.fn().mockResolvedValue({
          userContext: {
            userId: 'user-1',
            projectIds: new Set(['p1']),
            mutedEventTypes: new Set(),
          },
          rooms: ['room-a'],
        }),
      })
      const resolver2 = createMockResolver({
        name: 'r2',
        onConnect: vi.fn().mockResolvedValue({
          userContext: {
            userId: 'user-1',
            projectIds: new Set(['p1', 'p2']),
            mutedEventTypes: new Set(),
          },
          rooms: ['room-b'],
        }),
      })

      const { manager } = createTestManager({ resolvers: [resolver1, resolver2] })
      await manager.handleConnect(createMockSession('conn-1'))

      const ctx = manager.getConnectionContext('conn-1')
      // Final userContext comes from the last resolver
      expect(ctx!.userContext.projectIds).toEqual(new Set(['p1', 'p2']))
      // Union of rooms from both resolvers
      expect(ctx!.rooms).toEqual(new Set(['room-a', 'room-b']))
    })

    it('should pass accumulated userContext to each resolver sequentially', async () => {
      const capturedContexts: TestUserContext[] = []

      const resolver1 = createMockResolver({
        name: 'r1',
        onConnect: vi.fn().mockImplementation((ctx: SubscriptionContext<TestUserContext>) => {
          capturedContexts.push({ ...ctx.userContext })
          return {
            userContext: {
              userId: 'user-1',
              projectIds: new Set(['p1']),
              mutedEventTypes: new Set(),
            },
            rooms: [],
          }
        }),
      })
      const resolver2 = createMockResolver({
        name: 'r2',
        onConnect: vi.fn().mockImplementation((ctx: SubscriptionContext<TestUserContext>) => {
          capturedContexts.push({ ...ctx.userContext })
          return {
            userContext: {
              userId: 'user-1',
              projectIds: new Set(['p1', 'p2']),
              mutedEventTypes: new Set(),
            },
            rooms: [],
          }
        }),
      })

      const { manager } = createTestManager({ resolvers: [resolver1, resolver2] })
      await manager.handleConnect(createMockSession('conn-1'))

      // First resolver sees initial context from resolveUserContext
      expect(capturedContexts[0]!.userId).toBe('user-1')
      expect(capturedContexts[0]!.projectIds.size).toBe(0)
      // Second resolver sees context updated by first resolver
      expect(capturedContexts[1]!.projectIds).toEqual(new Set(['p1']))
    })

    it('should work when resolvers have no onConnect', async () => {
      const resolver = createMockResolver({ name: 'no-connect' })
      // Resolver has no onConnect method

      const { manager } = createTestManager({ resolvers: [resolver] })
      await manager.handleConnect(createMockSession('conn-1'))

      const ctx = manager.getConnectionContext('conn-1')
      expect(ctx).toBeDefined()
      expect(ctx!.connectionId).toBe('conn-1')
    })

    it('should index by userId when resolveUserId is provided', async () => {
      const resolver = createMockResolver({
        name: 'r1',
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-a'],
        }),
      })
      const { manager } = createTestManager({
        resolvers: [resolver],
        resolveUserId: (ctx) => ctx.userId,
      })

      await manager.handleConnect(createMockSession('conn-1'))
      await manager.handleConnect(createMockSession('conn-2'))

      // Verify by using refreshUser (it would fail if index was not built)
      await expect(manager.refreshUser('user-1')).resolves.not.toThrow()
    })

    it('should reject when resolver onConnect throws', async () => {
      const resolver = createMockResolver({
        name: 'failing',
        onConnect: vi.fn().mockRejectedValue(new Error('boom')),
      })

      const { manager } = createTestManager({ resolvers: [resolver] })

      await expect(manager.handleConnect(createMockSession('conn-1'))).rejects.toThrow('boom')
    })
  })

  describe('handleDisconnect', () => {
    it('should remove connection state', async () => {
      const resolver = createMockResolver({
        name: 'r1',
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-a'],
        }),
      })
      const { manager } = createTestManager({ resolvers: [resolver] })

      await manager.handleConnect(createMockSession('conn-1'))
      expect(manager.getConnectionContext('conn-1')).toBeDefined()

      manager.handleDisconnect(createMockSession('conn-1'))
      expect(manager.getConnectionContext('conn-1')).toBeUndefined()
    })

    it('should remove from userConnections index', async () => {
      const resolver = createMockResolver({
        name: 'r1',
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: [],
        }),
        refresh: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: [],
        }),
      })
      const { manager } = createTestManager({
        resolvers: [resolver],
        resolveUserId: (ctx) => ctx.userId,
      })

      await manager.handleConnect(createMockSession('conn-1'))
      manager.handleDisconnect(createMockSession('conn-1'))

      // refreshUser should no-op (no connections for user-1)
      // If the index still had conn-1, refreshConnection would throw for unknown connection
      await expect(manager.refreshUser('user-1')).resolves.not.toThrow()
    })

    it('should be idempotent for unknown connections', () => {
      const { manager } = createTestManager()
      // Should not throw
      manager.handleDisconnect(createMockSession('non-existent'))
    })
  })

  describe('publish — pipeline evaluation', () => {
    async function setupConnectedManager(
      resolvers: SubscriptionResolver<TestUserContext, TestMetadata>[],
      overrides?: Partial<SSESubscriptionManagerConfig<TestUserContext, TestMetadata>>,
    ) {
      // Each resolver must have an onConnect to join rooms
      const resolversWithConnect = resolvers.map((r) => ({
        ...r,
        onConnect:
          r.onConnect ??
          vi.fn().mockResolvedValue({
            userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
            rooms: ['room-a'],
          }),
      }))

      const result = createTestManager({ resolvers: resolversWithConnect, ...overrides })
      await result.manager.handleConnect(createMockSession('conn-1'))
      return result
    }

    const testEvent: IncomingEvent<TestMetadata> = {
      eventName: 'test',
      data: { value: 1 },
      targetRooms: ['room-a'],
      metadata: { scope: 'global' } as TestMetadata,
    }

    it('should deliver when all resolvers defer and defaultPolicy is allow', async () => {
      const resolver = createMockResolver({
        name: 'deferred',
        evaluate: vi.fn().mockReturnValue({ action: 'defer' }),
      })
      const { manager, sendEvent } = await setupConnectedManager([resolver], {
        defaultPolicy: 'allow',
      })

      const result = await manager.publish(testEvent)

      expect(sendEvent).toHaveBeenCalledTimes(1)
      expect(result.delivered).toBe(1)
      expect(result.filtered).toBe(0)
    })

    it('should filter when all resolvers defer and defaultPolicy is deny (default)', async () => {
      const resolver = createMockResolver({
        name: 'deferred',
        evaluate: vi.fn().mockReturnValue({ action: 'defer' }),
      })
      const { manager, sendEvent } = await setupConnectedManager([resolver])

      const result = await manager.publish(testEvent)

      expect(sendEvent).not.toHaveBeenCalled()
      expect(result.delivered).toBe(0)
      expect(result.filtered).toBe(1)
    })

    it('should deliver when a resolver allows and none deny', async () => {
      const resolver1 = createMockResolver({
        name: 'r1',
        evaluate: vi.fn().mockReturnValue({ action: 'defer' }),
      })
      const resolver2 = createMockResolver({
        name: 'r2',
        evaluate: vi.fn().mockReturnValue({ action: 'allow' }),
      })
      const { manager, sendEvent } = await setupConnectedManager([resolver1, resolver2])

      const result = await manager.publish(testEvent)

      expect(sendEvent).toHaveBeenCalledTimes(1)
      expect(result.delivered).toBe(1)
    })

    it('should filter when any resolver denies (deny-wins)', async () => {
      const resolver1 = createMockResolver({
        name: 'r1',
        evaluate: vi.fn().mockReturnValue({ action: 'allow' }),
      })
      const resolver2 = createMockResolver({
        name: 'r2',
        evaluate: vi.fn().mockReturnValue({ action: 'deny', reason: 'nope' }),
      })
      const { manager, sendEvent } = await setupConnectedManager([resolver1, resolver2])

      const result = await manager.publish(testEvent)

      expect(sendEvent).not.toHaveBeenCalled()
      expect(result.filtered).toBe(1)
    })

    it('should short-circuit on first deny — skip remaining resolvers', async () => {
      const resolver1 = createMockResolver({
        name: 'r1',
        evaluate: vi.fn().mockReturnValue({ action: 'deny', reason: 'blocked' }),
      })
      const resolver2 = createMockResolver({
        name: 'r2',
        evaluate: vi.fn().mockReturnValue({ action: 'allow' }),
      })
      const { manager } = await setupConnectedManager([resolver1, resolver2])

      await manager.publish(testEvent)

      expect(resolver1.evaluate).toHaveBeenCalledTimes(1)
      expect(resolver2.evaluate).not.toHaveBeenCalled()
    })

    it('should NOT short-circuit on allow — remaining resolvers still run', async () => {
      const resolver1 = createMockResolver({
        name: 'r1',
        evaluate: vi.fn().mockReturnValue({ action: 'allow' }),
      })
      const resolver2 = createMockResolver({
        name: 'r2',
        evaluate: vi.fn().mockReturnValue({ action: 'defer' }),
      })
      const { manager } = await setupConnectedManager([resolver1, resolver2])

      await manager.publish(testEvent)

      expect(resolver1.evaluate).toHaveBeenCalledTimes(1)
      expect(resolver2.evaluate).toHaveBeenCalledTimes(1)
    })

    it('should evaluate resolvers in array order', async () => {
      const callOrder: string[] = []
      const resolver1 = createMockResolver({
        name: 'first',
        evaluate: vi.fn().mockImplementation(() => {
          callOrder.push('first')
          return { action: 'defer' as const }
        }),
      })
      const resolver2 = createMockResolver({
        name: 'second',
        evaluate: vi.fn().mockImplementation(() => {
          callOrder.push('second')
          return { action: 'allow' as const }
        }),
      })
      const { manager } = await setupConnectedManager([resolver1, resolver2])

      await manager.publish(testEvent)

      expect(callOrder).toEqual(['first', 'second'])
    })

    it('should treat resolver evaluate errors as deny', async () => {
      const resolver = createMockResolver({
        name: 'buggy',
        evaluate: vi.fn().mockImplementation(() => {
          throw new Error('kaboom')
        }),
      })
      const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
      const { manager, sendEvent } = await setupConnectedManager([resolver], { logger })

      const result = await manager.publish(testEvent)

      expect(sendEvent).not.toHaveBeenCalled()
      expect(result.filtered).toBe(1)
    })
  })

  describe('publish — room-based routing', () => {
    it('should broadcast to targetRooms via broadcaster with metadata', async () => {
      const resolver = createMockResolver({
        name: 'r1',
        evaluate: vi.fn().mockReturnValue({ action: 'allow' }),
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-a'],
        }),
      })
      const { manager, sendEvent } = createTestManager({ resolvers: [resolver] })
      await manager.handleConnect(createMockSession('conn-1'))

      await manager.publish({
        eventName: 'test',
        data: { value: 1 },
        targetRooms: ['room-a'],
        metadata: { scope: 'project', projectId: 'p1' } as TestMetadata,
      })

      expect(sendEvent).toHaveBeenCalledTimes(1)
      expect(sendEvent).toHaveBeenCalledWith(
        'conn-1',
        expect.objectContaining({ event: 'test', data: { value: 1 } }),
      )
    })

    it('should fall back to all managed connections when no targetRooms', async () => {
      const resolver = createMockResolver({
        name: 'r1',
        evaluate: vi.fn().mockReturnValue({ action: 'allow' }),
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-a'],
        }),
      })
      const { manager, sendEvent } = createTestManager({ resolvers: [resolver] })
      await manager.handleConnect(createMockSession('conn-1'))
      await manager.handleConnect(createMockSession('conn-2'))

      const result = await manager.publish({
        eventName: 'test',
        data: {},
        metadata: { scope: 'global' } as TestMetadata,
        // no targetRooms
      })

      expect(sendEvent).toHaveBeenCalledTimes(2)
      expect(result.delivered).toBe(2)
    })

    it('should return { delivered: 0, filtered: 0 } for empty targetRooms array', async () => {
      const resolver = createMockResolver({
        name: 'r1',
        evaluate: vi.fn().mockReturnValue({ action: 'allow' }),
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-a'],
        }),
      })
      const { manager, sendEvent } = createTestManager({ resolvers: [resolver] })
      await manager.handleConnect(createMockSession('conn-1'))

      const result = await manager.publish({
        eventName: 'test',
        data: {},
        targetRooms: [],
        metadata: { scope: 'global' } as TestMetadata,
      })

      // Explicit empty array means "publish to zero rooms" — no connections evaluated
      expect(result.delivered).toBe(0)
      expect(result.filtered).toBe(0)
      expect(sendEvent).not.toHaveBeenCalled()
    })

    it('should deduplicate connections across multiple targetRooms', async () => {
      const resolver = createMockResolver({
        name: 'r1',
        evaluate: vi.fn().mockReturnValue({ action: 'allow' }),
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-a', 'room-b'],
        }),
      })
      const { manager, sendEvent } = createTestManager({ resolvers: [resolver] })
      await manager.handleConnect(createMockSession('conn-1'))

      const result = await manager.publish({
        eventName: 'test',
        data: {},
        targetRooms: ['room-a', 'room-b'],
        metadata: { scope: 'global' } as TestMetadata,
      })

      // conn-1 is in both rooms but should only receive once
      expect(sendEvent).toHaveBeenCalledTimes(1)
      expect(result.delivered).toBe(1)
    })
  })

  describe('publish — delivery counting', () => {
    it('should return correct delivered/filtered counts', async () => {
      const resolver = createMockResolver({
        name: 'r1',
        evaluate: vi.fn().mockImplementation((ctx: SubscriptionContext<TestUserContext>) => {
          if (ctx.connectionId === 'conn-1') return { action: 'allow' as const }
          if (ctx.connectionId === 'conn-2') return { action: 'deny' as const }
          return { action: 'allow' as const }
        }),
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-a'],
        }),
      })
      const { manager } = createTestManager({ resolvers: [resolver] })
      await manager.handleConnect(createMockSession('conn-1'))
      await manager.handleConnect(createMockSession('conn-2'))
      await manager.handleConnect(createMockSession('conn-3'))

      const result = await manager.publish({
        eventName: 'test',
        data: {},
        targetRooms: ['room-a'],
        metadata: { scope: 'global' } as TestMetadata,
      })

      expect(result.delivered).toBe(2)
      expect(result.filtered).toBe(1)
    })

    it('should handle no managed connections', async () => {
      const { manager } = createTestManager()

      const result = await manager.publish({
        eventName: 'test',
        data: {},
        targetRooms: ['room-a'],
        metadata: { scope: 'global' } as TestMetadata,
      })

      expect(result.delivered).toBe(0)
      expect(result.filtered).toBe(0)
    })

    it('should handle async evaluate resolvers', async () => {
      const resolver = createMockResolver({
        name: 'async-resolver',
        evaluate: vi.fn().mockResolvedValue({ action: 'allow' }),
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-a'],
        }),
      })
      const { manager } = createTestManager({ resolvers: [resolver] })
      await manager.handleConnect(createMockSession('conn-1'))

      const result = await manager.publish({
        eventName: 'test',
        data: {},
        targetRooms: ['room-a'],
        metadata: { scope: 'global' } as TestMetadata,
      })

      expect(result.delivered).toBe(1)
      expect(result.filtered).toBe(0)
    })
  })

  describe('shouldDeliver (pre-delivery filter)', () => {
    it('should return true for connections not managed by this manager', async () => {
      const { manager } = createTestManager()

      const result = await manager.shouldDeliver('unknown-conn', {
        event: 'test',
        data: {},
        id: 'msg-1',
      })

      expect(result).toBe(true)
    })

    it('should run pipeline and return true for allowed connections', async () => {
      const resolver = createMockResolver({
        name: 'r1',
        evaluate: vi.fn().mockReturnValue({ action: 'allow' }),
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-a'],
        }),
      })
      const { manager } = createTestManager({ resolvers: [resolver] })
      await manager.handleConnect(createMockSession('conn-1'))

      const result = await manager.shouldDeliver('conn-1', {
        event: 'test',
        data: {},
        id: 'msg-1',
      })

      expect(result).toBe(true)
    })

    it('should run pipeline and return false for denied connections', async () => {
      const resolver = createMockResolver({
        name: 'r1',
        evaluate: vi.fn().mockReturnValue({ action: 'deny' }),
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-a'],
        }),
      })
      const { manager } = createTestManager({ resolvers: [resolver] })
      await manager.handleConnect(createMockSession('conn-1'))

      const result = await manager.shouldDeliver('conn-1', {
        event: 'test',
        data: {},
        id: 'msg-1',
      })

      expect(result).toBe(false)
    })
  })

  describe('refreshConnection', () => {
    it('should call refresh on resolvers that define it', async () => {
      const refreshFn = vi.fn().mockResolvedValue({
        userContext: { userId: 'user-1', projectIds: new Set(['p1']), mutedEventTypes: new Set() },
        rooms: ['room-a'],
      })
      const resolver = createMockResolver({
        name: 'r1',
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-a'],
        }),
        refresh: refreshFn,
      })
      const { manager } = createTestManager({ resolvers: [resolver] })
      await manager.handleConnect(createMockSession('conn-1'))

      await manager.refreshConnection('conn-1')

      expect(refreshFn).toHaveBeenCalledTimes(1)
      const ctx = manager.getConnectionContext('conn-1')
      expect(ctx!.userContext.projectIds).toEqual(new Set(['p1']))
    })

    it('should skip resolvers without refresh', async () => {
      const resolver1 = createMockResolver({
        name: 'r1',
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-a'],
        }),
        // no refresh
      })
      const refreshFn = vi.fn().mockResolvedValue({
        userContext: { userId: 'user-1', projectIds: new Set(['p2']), mutedEventTypes: new Set() },
        rooms: ['room-a'],
      })
      const resolver2 = createMockResolver({
        name: 'r2',
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-b'],
        }),
        refresh: refreshFn,
      })
      const { manager } = createTestManager({ resolvers: [resolver1, resolver2] })
      await manager.handleConnect(createMockSession('conn-1'))

      await manager.refreshConnection('conn-1')

      expect(refreshFn).toHaveBeenCalledTimes(1)
      // resolver1 has no refresh, should not be called
    })

    it('should join new rooms added by resolver', async () => {
      const resolver = createMockResolver({
        name: 'r1',
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-a'],
        }),
        refresh: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-a', 'room-b'],
        }),
      })
      const { manager, roomManager } = createTestManager({ resolvers: [resolver] })
      await manager.handleConnect(createMockSession('conn-1'))
      expect(roomManager.getRooms('conn-1')).toEqual(['room-a'])

      await manager.refreshConnection('conn-1')

      expect(roomManager.getRooms('conn-1').sort()).toEqual(['room-a', 'room-b'])
    })

    it('should leave rooms dropped by a resolver when no other resolver claims them', async () => {
      const resolver = createMockResolver({
        name: 'r1',
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-a', 'room-b'],
        }),
        refresh: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-a'],
        }),
      })
      const { manager, roomManager } = createTestManager({ resolvers: [resolver] })
      await manager.handleConnect(createMockSession('conn-1'))
      expect(roomManager.getRooms('conn-1').sort()).toEqual(['room-a', 'room-b'])

      await manager.refreshConnection('conn-1')

      expect(roomManager.getRooms('conn-1')).toEqual(['room-a'])
    })

    it('should NOT leave room still claimed by another resolver', async () => {
      const resolver1 = createMockResolver({
        name: 'r1',
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-shared', 'room-only-r1'],
        }),
        refresh: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-only-r1'],
          // Drops room-shared
        }),
      })
      const resolver2 = createMockResolver({
        name: 'r2',
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-shared'],
        }),
        // No refresh — keeps its rooms from onConnect
      })
      const { manager, roomManager } = createTestManager({ resolvers: [resolver1, resolver2] })
      await manager.handleConnect(createMockSession('conn-1'))
      expect(roomManager.getRooms('conn-1').sort()).toEqual(['room-only-r1', 'room-shared'])

      await manager.refreshConnection('conn-1')

      // room-shared should still be present because resolver2 still claims it
      expect(roomManager.getRooms('conn-1').sort()).toEqual(['room-only-r1', 'room-shared'])
    })

    it('should replace userContext immutably — new object reference', async () => {
      const resolver = createMockResolver({
        name: 'r1',
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-a'],
        }),
        refresh: vi.fn().mockResolvedValue({
          userContext: {
            userId: 'user-1',
            projectIds: new Set(['new']),
            mutedEventTypes: new Set(),
          },
          rooms: ['room-a'],
        }),
      })
      const { manager } = createTestManager({ resolvers: [resolver] })
      await manager.handleConnect(createMockSession('conn-1'))
      const ctxBefore = manager.getConnectionContext('conn-1')

      await manager.refreshConnection('conn-1')

      const ctxAfter = manager.getConnectionContext('conn-1')
      expect(ctxAfter).not.toBe(ctxBefore)
      expect(ctxAfter!.userContext).not.toBe(ctxBefore!.userContext)
      expect(ctxAfter!.userContext.projectIds).toEqual(new Set(['new']))
    })

    it('should throw for unknown connectionId', async () => {
      const { manager } = createTestManager()

      await expect(manager.refreshConnection('unknown')).rejects.toThrow(
        'Unknown connection: unknown',
      )
    })

    it('should pass accumulated context through refresh chain', async () => {
      const capturedContexts: TestUserContext[] = []

      const resolver1 = createMockResolver({
        name: 'r1',
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-a'],
        }),
        refresh: vi.fn().mockImplementation((ctx: SubscriptionContext<TestUserContext>) => {
          capturedContexts.push({ ...ctx.userContext })
          return {
            userContext: {
              userId: 'user-1',
              projectIds: new Set(['from-r1']),
              mutedEventTypes: new Set(),
            },
            rooms: ['room-a'],
          }
        }),
      })
      const resolver2 = createMockResolver({
        name: 'r2',
        onConnect: vi.fn().mockResolvedValue({
          userContext: {
            userId: 'user-1',
            projectIds: new Set(['from-r1']),
            mutedEventTypes: new Set(),
          },
          rooms: ['room-b'],
        }),
        refresh: vi.fn().mockImplementation((ctx: SubscriptionContext<TestUserContext>) => {
          capturedContexts.push({ ...ctx.userContext })
          return {
            userContext: {
              userId: 'user-1',
              projectIds: new Set(['from-r1', 'from-r2']),
              mutedEventTypes: new Set(),
            },
            rooms: ['room-b'],
          }
        }),
      })
      const { manager } = createTestManager({ resolvers: [resolver1, resolver2] })
      await manager.handleConnect(createMockSession('conn-1'))

      await manager.refreshConnection('conn-1')

      // resolver2's refresh should see the userContext output of resolver1's refresh
      expect(capturedContexts[1]!.projectIds).toEqual(new Set(['from-r1']))
    })

    it('should continue refreshing other resolvers when one throws', async () => {
      const resolver1 = createMockResolver({
        name: 'r1',
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-a'],
        }),
        refresh: vi.fn().mockRejectedValue(new Error('refresh failed')),
      })
      const resolver2 = createMockResolver({
        name: 'r2',
        onConnect: vi.fn().mockResolvedValue({
          userContext: {
            userId: 'user-1',
            projectIds: new Set(['p1']),
            mutedEventTypes: new Set(),
          },
          rooms: ['room-b'],
        }),
        refresh: vi.fn().mockResolvedValue({
          userContext: {
            userId: 'user-1',
            projectIds: new Set(['p1', 'p2']),
            mutedEventTypes: new Set(),
          },
          rooms: ['room-b', 'room-c'],
        }),
      })
      const { manager } = createTestManager({ resolvers: [resolver1, resolver2] })
      await manager.handleConnect(createMockSession('conn-1'))

      // Should not throw — errors are caught and logged
      await manager.refreshConnection('conn-1')

      // resolver1's rooms should be kept (from onConnect), resolver2's rooms should be updated
      const ctx = manager.getConnectionContext('conn-1')
      expect(ctx).toBeDefined()
      expect(ctx!.rooms.has('room-a')).toBe(true) // kept from r1's onConnect
      expect(ctx!.rooms.has('room-b')).toBe(true) // kept from r2's refresh
      expect(ctx!.rooms.has('room-c')).toBe(true) // added by r2's refresh
      expect(ctx!.userContext.projectIds).toEqual(new Set(['p1', 'p2'])) // from r2's refresh
    })
  })

  describe('refreshUser', () => {
    it('should refresh all connections for a userId', async () => {
      const refreshFn = vi.fn().mockResolvedValue({
        userContext: {
          userId: 'user-1',
          projectIds: new Set(['refreshed']),
          mutedEventTypes: new Set(),
        },
        rooms: ['room-a'],
      })
      const resolver = createMockResolver({
        name: 'r1',
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-a'],
        }),
        refresh: refreshFn,
      })
      const { manager } = createTestManager({
        resolvers: [resolver],
        resolveUserId: (ctx) => ctx.userId,
      })
      await manager.handleConnect(createMockSession('conn-1'))
      await manager.handleConnect(createMockSession('conn-2'))

      await manager.refreshUser('user-1')

      expect(refreshFn).toHaveBeenCalledTimes(2)
      expect(manager.getConnectionContext('conn-1')!.userContext.projectIds).toEqual(
        new Set(['refreshed']),
      )
      expect(manager.getConnectionContext('conn-2')!.userContext.projectIds).toEqual(
        new Set(['refreshed']),
      )
    })

    it('should throw if resolveUserId not configured', async () => {
      const { manager } = createTestManager()

      await expect(manager.refreshUser('user-1')).rejects.toThrow('resolveUserId not configured')
    })

    it('should no-op for user with no active connections', async () => {
      const resolver = createMockResolver({
        name: 'r1',
        refresh: vi.fn(),
      })
      const { manager } = createTestManager({
        resolvers: [resolver],
        resolveUserId: (ctx) => ctx.userId,
      })

      // No connections registered — should not throw and not call refresh
      await manager.refreshUser('non-existent-user')
      expect(resolver.refresh).not.toHaveBeenCalled()
    })

    it('should re-key the userConnections index when refresh changes the userId', async () => {
      const resolver = createMockResolver({
        name: 'rotate-user',
        onConnect: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-1', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-a'],
        }),
        refresh: vi.fn().mockResolvedValue({
          userContext: { userId: 'user-2', projectIds: new Set(), mutedEventTypes: new Set() },
          rooms: ['room-a'],
        }),
      })
      const { manager } = createTestManager({
        resolvers: [resolver],
        resolveUserId: (ctx) => ctx.userId,
      })
      await manager.handleConnect(createMockSession('conn-1'))

      await manager.refreshConnection('conn-1')

      // Old bucket should be empty (deleted), new bucket should contain conn-1.
      // refreshUser on the old id should be a no-op; on the new id it should
      // refresh the connection again.
      const refreshSpy = resolver.refresh as ReturnType<typeof vi.fn>
      refreshSpy.mockClear()

      await manager.refreshUser('user-1')
      expect(refreshSpy).not.toHaveBeenCalled()

      await manager.refreshUser('user-2')
      expect(refreshSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('getConnectionContext', () => {
    it('should return context for known connection', async () => {
      const resolver = createMockResolver({
        name: 'r1',
        onConnect: vi.fn().mockResolvedValue({
          userContext: {
            userId: 'user-1',
            projectIds: new Set(['p1']),
            mutedEventTypes: new Set(),
          },
          rooms: ['room-a'],
        }),
      })
      const { manager } = createTestManager({ resolvers: [resolver] })
      await manager.handleConnect(createMockSession('conn-1'))

      const ctx = manager.getConnectionContext('conn-1')

      expect(ctx).toBeDefined()
      expect(ctx!.connectionId).toBe('conn-1')
      expect(ctx!.userContext.userId).toBe('user-1')
      expect(ctx!.userContext.projectIds).toEqual(new Set(['p1']))
      expect(ctx!.rooms).toEqual(new Set(['room-a']))
    })

    it('should return undefined for unknown connection', () => {
      const { manager } = createTestManager()

      expect(manager.getConnectionContext('unknown')).toBeUndefined()
    })
  })
})
