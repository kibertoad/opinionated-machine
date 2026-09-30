import { defineApiContract, sseBody } from '@lokalise/api-contracts'
import type { SSESession } from '@lokalise/fastify-api-contracts'
import type { RouteOptions } from 'fastify'
import { z } from 'zod/v4'
import {
  AbstractModule,
  asSingletonClass,
  asSingletonFunction,
  type CreateSSESessionSpyResult,
  defineEventMetadata,
  type FilterVerdict,
  type IncomingEvent,
  type MandatoryNameAndRegistrationPair,
  type ResolverResult,
  SSERoomBroadcaster,
  SSERoomManager,
  SSESubscriptionManager,
  type SubscriptionContext,
} from '../../../index.js'
import {
  AbstractApiController,
  asApiControllerClass,
  buildApiRoute,
} from '../../../lib/api-contracts/index.ts'

// ============================================================================
// Types
// ============================================================================

export type TestUserContext = {
  userId: string
  projectIds: Set<string>
  mutedEventTypes: Set<string>
}

export type TestEventMetadata = { scope: 'project'; projectId: string }

export const testMeta = defineEventMetadata<TestEventMetadata>()('scope', ['project'])

// ============================================================================
// Contract
// ============================================================================

export const subscriptionStreamContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'User-centered subscription stream',
  pathResolver: () => '/api/subscriptions/stream',
  requestQuerySchema: z.object({
    userId: z.string().optional(),
  }),
  responsesByStatusCode: {
    200: {
      content: {
        'text/event-stream': sseBody({
          announcement: z.object({ message: z.string() }),
          update: z.object({ entity: z.string(), action: z.string() }),
        }),
      },
    },
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
    return this.resolve(ctx)
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
    return { action: 'defer' }
  }

  refresh(ctx: SubscriptionContext<TestUserContext>): ResolverResult<TestUserContext> {
    return this.resolve(ctx)
  }

  private resolve(ctx: SubscriptionContext<TestUserContext>): ResolverResult<TestUserContext> {
    const projectIds = new Set(this.projectService.getMemberships(ctx.userContext.userId))
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
    return this.resolve(ctx)
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
    return this.resolve(ctx)
  }

  private resolve(ctx: SubscriptionContext<TestUserContext>): ResolverResult<TestUserContext> {
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

/**
 * Wraps the route's SSE lifecycle hooks, e.g. `createSSESessionSpy().withSpy`.
 * It has to be applied when the route is built, so it is a dependency.
 */
export type SubscriptionStreamHooksDecorator = CreateSSESessionSpyResult['withSpy']

export type SubscriptionStreamControllerDependencies = {
  sseRoomManager: SSERoomManager
  sseRoomBroadcaster: SSERoomBroadcaster
  projectService: MockProjectService
  preferencesService: MockPreferencesService
  subscriptionStreamHooksDecorator: SubscriptionStreamHooksDecorator | undefined
}

/**
 * Wires an `SSESubscriptionManager` to a `buildApiRoute` SSE route:
 *
 * - `sseRooms` registers each session with the shared broadcaster, so the rooms
 *   the manager joins (directly on `SSERoomManager`) are delivered to it.
 * - `onConnect` runs `handleConnect`, which resolves the user context from the
 *   request and joins the rooms the resolvers declare.
 * - `onClose` runs `handleDisconnect`.
 */
export class SubscriptionStreamController extends AbstractApiController<
  typeof SubscriptionStreamController.contracts
> {
  static contracts = { subscriptionStream: subscriptionStreamContract } as const

  readonly routes: Record<keyof typeof SubscriptionStreamController.contracts, RouteOptions>

  readonly subscriptionManager: SSESubscriptionManager<TestUserContext, TestEventMetadata>

  // `onConnect` is not awaited by the route builder, so the client can close
  // while `handleConnect` is still running the resolver chain. `onClose` waits
  // for the matching connect to settle; otherwise disconnect would run first
  // and the connect would then leave a managed entry behind.
  private readonly pendingConnects = new Map<string, Promise<void>>()

  constructor(deps: SubscriptionStreamControllerDependencies) {
    super()

    this.subscriptionManager = new SSESubscriptionManager<TestUserContext, TestEventMetadata>(
      {
        resolveUserContext: (request) =>
          Promise.resolve({
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

    const hooks = {
      onConnect: (session: SSESession) => this.connect(session),
      onClose: (session: SSESession) => this.disconnect(session),
    }
    const decorate = deps.subscriptionStreamHooksDecorator

    this.routes = {
      subscriptionStream: buildApiRoute(
        SubscriptionStreamController.contracts.subscriptionStream,
        (_request, _reply, { sse }) => {
          sse.start('keepAlive')
        },
        { ...(decorate ? decorate(hooks) : hooks), sseRooms: deps.sseRoomBroadcaster },
      ),
    }
  }

  private connect(session: SSESession): Promise<void> {
    const connected = this.subscriptionManager.handleConnect(session)
    // The route logs a rejected onConnect; the pending entry must not reject,
    // so that disconnect still runs after a failed connect.
    const settled = connected
      .catch(() => {})
      .finally(() => {
        this.pendingConnects.delete(session.id)
      })
    this.pendingConnects.set(session.id, settled)
    return connected
  }

  private async disconnect(session: SSESession): Promise<void> {
    await this.pendingConnects.get(session.id)
    this.subscriptionManager.handleDisconnect(session)
  }
}

// ============================================================================
// Module
// ============================================================================

export type SubscriptionTestModuleDependencies = SubscriptionStreamControllerDependencies

export type SubscriptionTestModuleControllers = {
  subscriptionStreamController: SubscriptionStreamController
}

export class SubscriptionTestModule extends AbstractModule<SubscriptionTestModuleDependencies> {
  private readonly projectService: MockProjectService
  private readonly preferencesService: MockPreferencesService
  private readonly hooksDecorator: SubscriptionStreamHooksDecorator | undefined

  constructor(options: {
    projectService: MockProjectService
    preferencesService: MockPreferencesService
    hooksDecorator?: SubscriptionStreamHooksDecorator
  }) {
    super()
    this.projectService = options.projectService
    this.preferencesService = options.preferencesService
    this.hooksDecorator = options.hooksDecorator
  }

  resolveDependencies(): MandatoryNameAndRegistrationPair<SubscriptionTestModuleDependencies> {
    const { projectService, preferencesService, hooksDecorator } = this
    return {
      sseRoomManager: asSingletonFunction((): SSERoomManager => new SSERoomManager()),
      sseRoomBroadcaster: asSingletonClass(SSERoomBroadcaster),
      projectService: asSingletonFunction((): MockProjectService => projectService),
      preferencesService: asSingletonFunction((): MockPreferencesService => preferencesService),
      subscriptionStreamHooksDecorator: asSingletonFunction(
        (): SubscriptionStreamHooksDecorator | undefined => hooksDecorator,
      ),
    }
  }

  override resolveControllers(): MandatoryNameAndRegistrationPair<unknown> {
    return {
      subscriptionStreamController: asApiControllerClass(SubscriptionStreamController),
    }
  }
}
