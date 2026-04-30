import { buildSseContract as buildContract } from '@lokalise/api-contracts'
import { z } from 'zod'
import {
  AbstractModule,
  AbstractSSEController,
  asSingletonClass,
  asSingletonFunction,
  asSSEControllerClass,
  type BuildFastifySSERoutesReturnType,
  buildHandler,
  type DependencyInjectionOptions,
  defineEventMetadata,
  type FilterVerdict,
  type IncomingEvent,
  type MandatoryNameAndRegistrationPair,
  type ResolverResult,
  type SSEControllerConfig,
  SSERoomBroadcaster,
  SSERoomManager,
  SSESubscriptionManager,
  type SubscriptionContext,
} from '../../../index.js'

// ============================================================================
// Types
// ============================================================================

export type TestUserContext = {
  userId: string
  projectIds: Set<string>
  mutedEventTypes: Set<string>
}

export type TestEventMetadata = { scope: 'project'; projectId: string } | { scope: 'global' }

export const testMeta = defineEventMetadata<TestEventMetadata>()('scope', ['project', 'global'])

// ============================================================================
// Contract
// ============================================================================

export const subscriptionStreamContract = buildContract({
  method: 'get',
  pathResolver: () => '/api/subscriptions/stream',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({
    userId: z.string().optional(),
  }),
  requestHeaderSchema: z.object({}),
  serverSentEventSchemas: {
    announcement: z.object({ message: z.string() }),
    alert: z.object({ level: z.string(), message: z.string() }),
    update: z.object({ entity: z.string(), action: z.string() }),
  },
})

// ============================================================================
// Mock Services
// ============================================================================

export class MockProjectService {
  private membershipsByUser: Map<string, string[]> = new Map()

  setMemberships(userId: string, projectIds: string[]): void {
    this.membershipsByUser.set(userId, projectIds)
  }

  getMemberships(userId: string): string[] {
    return this.membershipsByUser.get(userId) ?? []
  }
}

export class MockPreferencesService {
  private mutesByUser: Map<string, string[]> = new Map()

  setMutedTypes(userId: string, eventTypes: string[]): void {
    this.mutesByUser.set(userId, eventTypes)
  }

  getMutedTypes(userId: string): string[] {
    return this.mutesByUser.get(userId) ?? []
  }
}

// ============================================================================
// Resolvers
// ============================================================================

export class ProjectMembershipResolver {
  readonly name = 'project-membership'
  private readonly projectService: MockProjectService

  constructor(projectService: MockProjectService) {
    this.projectService = projectService
  }

  onConnect(ctx: SubscriptionContext<TestUserContext>): ResolverResult<TestUserContext> {
    const memberships = this.projectService.getMemberships(ctx.userContext.userId)
    const projectIds = new Set(memberships)

    return {
      userContext: { ...ctx.userContext, projectIds },
      rooms: Array.from(projectIds).map((id) => `project:${id}`),
    }
  }

  evaluate(
    ctx: SubscriptionContext<TestUserContext>,
    event: IncomingEvent<TestEventMetadata>,
  ): FilterVerdict {
    if (testMeta.project(event.metadata)) {
      return ctx.userContext.projectIds.has(event.metadata.projectId)
        ? { action: 'allow' }
        : { action: 'deny', reason: 'not a project member' }
    }
    // Global-scoped events have no project gate — allow them through.
    // Without this, `defaultPolicy: 'deny'` would drop every global event.
    if (testMeta.global(event.metadata)) {
      return { action: 'allow' }
    }
    return { action: 'defer' }
  }

  refresh(ctx: SubscriptionContext<TestUserContext>): ResolverResult<TestUserContext> {
    const memberships = this.projectService.getMemberships(ctx.userContext.userId)
    const projectIds = new Set(memberships)

    return {
      userContext: { ...ctx.userContext, projectIds },
      rooms: Array.from(projectIds).map((id) => `project:${id}`),
    }
  }
}

export class MutePreferencesResolver {
  readonly name = 'mute-preferences'
  private readonly preferencesService: MockPreferencesService

  constructor(preferencesService: MockPreferencesService) {
    this.preferencesService = preferencesService
  }

  onConnect(ctx: SubscriptionContext<TestUserContext>): ResolverResult<TestUserContext> {
    const mutedTypes = this.preferencesService.getMutedTypes(ctx.userContext.userId)
    return {
      userContext: { ...ctx.userContext, mutedEventTypes: new Set(mutedTypes) },
      rooms: [],
    }
  }

  evaluate(
    ctx: SubscriptionContext<TestUserContext>,
    event: IncomingEvent<TestEventMetadata>,
  ): FilterVerdict {
    if (ctx.userContext.mutedEventTypes.has(event.eventName)) {
      return { action: 'deny', reason: 'event type muted' }
    }
    return { action: 'defer' }
  }

  refresh(ctx: SubscriptionContext<TestUserContext>): ResolverResult<TestUserContext> {
    const mutedTypes = this.preferencesService.getMutedTypes(ctx.userContext.userId)
    return {
      userContext: { ...ctx.userContext, mutedEventTypes: new Set(mutedTypes) },
      rooms: [],
    }
  }
}

// ============================================================================
// Controller
// ============================================================================

export type SubscriptionStreamContracts = {
  subscriptionStream: typeof subscriptionStreamContract
}

export class SubscriptionStreamController extends AbstractSSEController<SubscriptionStreamContracts> {
  public static contracts = {
    subscriptionStream: subscriptionStreamContract,
  } as const

  public readonly subscriptionManager: SSESubscriptionManager<TestUserContext, TestEventMetadata>

  // Tracks in-flight handleConnect() promises keyed by connection id, so that
  // onClose can wait for connect to settle before dispatching the matching
  // disconnect. Without this, a client closing during the resolver chain would
  // produce an out-of-order disconnect→connect and leak a managed entry.
  // Tests can also await this via {@link awaitSubscriptionConnect} to avoid
  // racy fixed sleeps after `awaitServerConnection`.
  private readonly pendingConnects = new Map<string, Promise<void>>()

  /**
   * Test helper: resolve once the SSESubscriptionManager has finished
   * processing handleConnect() for `connectionId`. Use after
   * `awaitServerConnection` (which only waits for SSE-level registration).
   */
  awaitSubscriptionConnect(connectionId: string): Promise<void> {
    return this.pendingConnects.get(connectionId) ?? Promise.resolve()
  }

  constructor(
    deps: {
      sseRoomManager: SSERoomManager
      sseRoomBroadcaster: SSERoomBroadcaster
      projectService: MockProjectService
      preferencesService: MockPreferencesService
    },
    sseConfig?: SSEControllerConfig,
  ) {
    super(deps, sseConfig)

    this.subscriptionManager = new SSESubscriptionManager<TestUserContext, TestEventMetadata>(
      {
        resolveUserContext: async (request) => ({
          userId: (request.query as { userId?: string }).userId ?? 'anonymous',
          projectIds: new Set<string>(),
          mutedEventTypes: new Set<string>(),
        }),
        resolvers: [
          new ProjectMembershipResolver(deps.projectService),
          new MutePreferencesResolver(deps.preferencesService),
        ],
        defaultPolicy: 'deny',
        resolveUserId: (ctx) => ctx.userId,
      },
      {
        sseRoomManager: deps.sseRoomManager,
        sseRoomBroadcaster: deps.sseRoomBroadcaster,
      },
    )
  }

  buildSSERoutes(): BuildFastifySSERoutesReturnType<SubscriptionStreamContracts> {
    return {
      subscriptionStream: this.handleSubscriptionStream,
    }
  }

  private handleSubscriptionStream = buildHandler(
    subscriptionStreamContract,
    {
      sse: (request, sse) => {
        const session = sse.start('keepAlive', {
          context: { userId: (request.query as { userId?: string }).userId },
        })

        // Track the connect promise so onClose can wait for it. We surface
        // setup failures via console.error rather than swallowing them, but
        // we still resolve so disconnect can proceed without dangling on a
        // rejected promise.
        const connectPromise = this.subscriptionManager
          .handleConnect(session)
          .catch((err) => {
            // Surface setup failures so a flaky resolver doesn't get hidden.
            // biome-ignore lint/suspicious/noConsole: test fixture diagnostics
            console.error('SubscriptionStream: handleConnect failed', err)
          })
          .finally(() => {
            this.pendingConnects.delete(session.id)
          })
        this.pendingConnects.set(session.id, connectPromise)
      },
    },
    {
      onClose: async (session) => {
        // Wait for any in-flight handleConnect to finish so we don't dispatch
        // disconnect before connect has registered the connection. If connect
        // already settled, this is a no-op.
        const pending = this.pendingConnects.get(session.id)
        if (pending) {
          await pending
        }
        this.subscriptionManager.handleDisconnect(session)
      },
    },
  )
}

// ============================================================================
// Module
// ============================================================================

export type SubscriptionTestModuleDependencies = {
  sseRoomManager: SSERoomManager
  sseRoomBroadcaster: SSERoomBroadcaster
  projectService: MockProjectService
  preferencesService: MockPreferencesService
}

export type SubscriptionTestModuleControllers = {
  subscriptionStreamController: SubscriptionStreamController
}

export class SubscriptionTestModule extends AbstractModule<SubscriptionTestModuleDependencies> {
  private readonly projectService: MockProjectService
  private readonly preferencesService: MockPreferencesService

  constructor(projectService: MockProjectService, preferencesService: MockPreferencesService) {
    super()
    this.projectService = projectService
    this.preferencesService = preferencesService
  }

  resolveDependencies(): MandatoryNameAndRegistrationPair<SubscriptionTestModuleDependencies> {
    const projectService = this.projectService
    const preferencesService = this.preferencesService
    return {
      sseRoomManager: asSingletonFunction((): SSERoomManager => new SSERoomManager()),
      sseRoomBroadcaster: asSingletonClass(SSERoomBroadcaster),
      projectService: asSingletonFunction((): MockProjectService => projectService),
      preferencesService: asSingletonFunction((): MockPreferencesService => preferencesService),
    }
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      subscriptionStreamController: asSSEControllerClass(SubscriptionStreamController, {
        diOptions,
        rooms: true,
      }),
    }
  }
}
