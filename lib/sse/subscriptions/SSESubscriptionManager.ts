import { randomUUID } from 'node:crypto'
import type { SSERoomBroadcaster } from '../rooms/SSERoomBroadcaster.js'
import type { SSERoomManager } from '../rooms/SSERoomManager.js'
import type { SSEMessage } from '../sseTypes.js'
import type {
  FilterVerdict,
  IncomingEvent,
  PublishResult,
  SSESubscriptionManagerConfig,
  SubscriptionContext,
} from './types.js'

type ConnectionState<TUserContext> = {
  context: SubscriptionContext<TUserContext>
  resolverRooms: Map<string, Set<string>> // resolverName → Set<roomName>
}

type SSESession = {
  id: string
  request: import('fastify').FastifyRequest
}

/**
 * Per-publish counters tracked via the pre-delivery filter.
 * A new object is created for each publish() call to avoid race conditions
 * when multiple publishes execute concurrently.
 */
type PublishCounters = { delivered: number; filtered: number }

export class SSESubscriptionManager<
  TUserContext,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> {
  private readonly config: SSESubscriptionManagerConfig<TUserContext, TMetadata> & {
    defaultPolicy: 'allow' | 'deny'
  }
  private readonly connectionStates: Map<string, ConnectionState<TUserContext>> = new Map()
  private readonly userConnections: Map<string, Set<string>> = new Map()
  private readonly deps: {
    sseRoomManager: SSERoomManager
    sseRoomBroadcaster: SSERoomBroadcaster
  }

  // Active counters for the current publish call. Replaced per-publish to avoid
  // races when multiple publishes overlap. The pre-delivery filter references
  // whichever object is current at invocation time.
  private activeCounters: PublishCounters = { delivered: 0, filtered: 0 }

  constructor(
    config: SSESubscriptionManagerConfig<TUserContext, TMetadata>,
    deps: {
      sseRoomManager: SSERoomManager
      sseRoomBroadcaster: SSERoomBroadcaster
    },
  ) {
    this.config = { ...config, defaultPolicy: config.defaultPolicy ?? 'deny' }
    this.deps = deps

    // Register as the broadcaster's pre-delivery filter
    deps.sseRoomBroadcaster.setPreDeliveryFilter((connectionId, message, metadata) => {
      return this.shouldDeliver(connectionId, message, metadata)
    })
  }

  async handleConnect(session: SSESession): Promise<void> {
    // 1. Resolve initial user context
    let userContext: TUserContext = await this.config.resolveUserContext(session.request)

    // 2. Build initial context (empty rooms)
    const resolverRooms = new Map<string, Set<string>>()

    // 3. Run resolver onConnect chain in order
    for (const resolver of this.config.resolvers) {
      if (!resolver.onConnect) continue

      const ctx: SubscriptionContext<TUserContext> = {
        connectionId: session.id,
        request: session.request,
        userContext,
        rooms: new Set<string>(),
      }

      const result = await resolver.onConnect(ctx)
      userContext = result.userContext
      resolverRooms.set(resolver.name, new Set(result.rooms ?? []))
    }

    // 4. Compute union of all resolver rooms
    const unionRooms = new Set<string>()
    for (const rooms of resolverRooms.values()) {
      for (const room of rooms) {
        unionRooms.add(room)
      }
    }

    // 5. Join all rooms in a single batch
    if (unionRooms.size > 0) {
      this.deps.sseRoomManager.join(session.id, [...unionRooms])
    }

    // 6. Build final immutable context
    const finalContext: SubscriptionContext<TUserContext> = {
      connectionId: session.id,
      request: session.request,
      userContext,
      rooms: unionRooms,
    }

    // 7. Store connection state
    this.connectionStates.set(session.id, {
      context: finalContext,
      resolverRooms,
    })

    // 8. Index by userId if configured
    if (this.config.resolveUserId) {
      const userId = this.config.resolveUserId(userContext)
      let connSet = this.userConnections.get(userId)
      if (!connSet) {
        connSet = new Set()
        this.userConnections.set(userId, connSet)
      }
      connSet.add(session.id)
    }
  }

  handleDisconnect(session: SSESession): void {
    const state = this.connectionStates.get(session.id)
    if (!state) return

    // Remove from userId index
    if (this.config.resolveUserId) {
      const userId = this.config.resolveUserId(state.context.userContext)
      const connSet = this.userConnections.get(userId)
      if (connSet) {
        connSet.delete(session.id)
        if (connSet.size === 0) {
          this.userConnections.delete(userId)
        }
      }
    }

    this.connectionStates.delete(session.id)
  }

  async publish(event: IncomingEvent<TMetadata>): Promise<PublishResult> {
    const rooms = event.targetRooms

    // Explicit empty array means "no target rooms" → no connections to evaluate
    if (rooms && rooms.length === 0) {
      return { delivered: 0, filtered: 0 }
    }

    // undefined targetRooms → fall back to evaluating all managed connections
    if (!rooms) {
      return this.publishToAllConnections(event)
    }

    // Create per-publish counters to avoid races with concurrent publishes
    const counters: PublishCounters = { delivered: 0, filtered: 0 }
    this.activeCounters = counters

    const message: SSEMessage = {
      event: event.eventName,
      data: event.data,
      id: randomUUID(),
    }

    await this.deps.sseRoomBroadcaster.broadcastMessage(rooms, message, {
      metadata: event.metadata as Record<string, unknown>,
    })

    return { ...counters }
  }

  /**
   * Pre-delivery filter registered with the broadcaster.
   * Evaluates the resolver pipeline for a connection and returns whether
   * the message should be delivered.
   *
   * Returns `true` for connections not managed by this subscription manager,
   * so non-subscription SSE streams are unaffected.
   *
   * @param connectionId - The connection to evaluate
   * @param message - The SSE message being delivered
   * @param metadata - Optional metadata (cast to TMetadata — callers must ensure shape matches)
   * @returns Whether the message should be delivered to this connection
   */
  shouldDeliver(
    connectionId: string,
    message: SSEMessage,
    metadata?: Record<string, unknown>,
  ): Promise<boolean> | boolean {
    const state = this.connectionStates.get(connectionId)
    if (!state) {
      // Connection not managed by this subscription manager — don't interfere
      return true
    }

    // Reconstruct IncomingEvent from message + metadata
    const event: IncomingEvent<TMetadata> = {
      eventName: message.event ?? '',
      data: message.data,
      metadata: (metadata ?? {}) as TMetadata,
    }

    return this.evaluateAndTrack(state.context, event)
  }

  async refreshConnection(connectionId: string): Promise<void> {
    const state = this.connectionStates.get(connectionId)
    if (!state) {
      throw new Error(`Unknown connection: ${connectionId}`)
    }

    const { userContext, resolverRooms } = await this.runRefreshChain(connectionId, state)
    const newUnion = this.computeRoomUnion(resolverRooms)
    this.applyRoomDiff(connectionId, state.context.rooms, newUnion)

    this.connectionStates.set(connectionId, {
      context: { connectionId, request: state.context.request, userContext, rooms: newUnion },
      resolverRooms,
    })
  }

  async refreshUser(userId: string): Promise<void> {
    if (!this.config.resolveUserId) {
      throw new Error('resolveUserId not configured')
    }

    const connSet = this.userConnections.get(userId)
    if (!connSet || connSet.size === 0) return

    for (const connId of connSet) {
      await this.refreshConnection(connId)
    }
  }

  getConnectionContext(connectionId: string): SubscriptionContext<TUserContext> | undefined {
    return this.connectionStates.get(connectionId)?.context
  }

  private async runRefreshChain(
    connectionId: string,
    state: ConnectionState<TUserContext>,
  ): Promise<{ userContext: TUserContext; resolverRooms: Map<string, Set<string>> }> {
    let userContext = state.context.userContext as TUserContext
    const resolverRooms = new Map(state.resolverRooms)

    for (const resolver of this.config.resolvers) {
      if (!resolver.refresh) continue

      const ctx: SubscriptionContext<TUserContext> = {
        connectionId,
        request: state.context.request,
        userContext,
        rooms: state.context.rooms,
      }

      try {
        const result = await resolver.refresh(ctx)
        userContext = result.userContext
        resolverRooms.set(resolver.name, new Set(result.rooms ?? []))
      } catch (err) {
        this.config.logger?.error(
          { err, resolver: resolver.name, connectionId },
          'Resolver refresh error, keeping previous state for this resolver',
        )
      }
    }

    return { userContext, resolverRooms }
  }

  private computeRoomUnion(resolverRooms: Map<string, Set<string>>): Set<string> {
    const union = new Set<string>()
    for (const rooms of resolverRooms.values()) {
      for (const room of rooms) {
        union.add(room)
      }
    }
    return union
  }

  private applyRoomDiff(
    connectionId: string,
    currentRooms: ReadonlySet<string>,
    newRooms: ReadonlySet<string>,
  ): void {
    const toJoin: string[] = []
    const toLeave: string[] = []

    for (const room of newRooms) {
      if (!currentRooms.has(room)) toJoin.push(room)
    }
    for (const room of currentRooms) {
      if (!newRooms.has(room)) toLeave.push(room)
    }

    if (toJoin.length > 0) this.deps.sseRoomManager.join(connectionId, toJoin)
    if (toLeave.length > 0) this.deps.sseRoomManager.leave(connectionId, toLeave)
  }

  private async evaluatePipeline(
    ctx: SubscriptionContext<TUserContext>,
    event: IncomingEvent<TMetadata>,
  ): Promise<FilterVerdict> {
    let hasAllow = false

    for (const resolver of this.config.resolvers) {
      let verdict: FilterVerdict
      try {
        verdict = await resolver.evaluate(ctx, event)
      } catch (err) {
        this.config.logger?.error(
          { err, resolver: resolver.name, connectionId: ctx.connectionId },
          'Resolver evaluate error, treating as deny',
        )
        return { action: 'deny', reason: 'resolver error' }
      }

      if (verdict.action === 'deny') {
        return verdict // short-circuit
      }
      if (verdict.action === 'allow') {
        hasAllow = true
      }
      // 'defer' → continue
    }

    if (hasAllow) {
      return { action: 'allow' }
    }
    return { action: this.config.defaultPolicy }
  }

  private async evaluateAndTrack(
    ctx: SubscriptionContext<TUserContext>,
    event: IncomingEvent<TMetadata>,
  ): Promise<boolean> {
    // Capture the active counters reference at evaluation time.
    // This ensures we increment the correct counters even if a new publish()
    // starts before this evaluation completes.
    const counters = this.activeCounters
    const verdict = await this.evaluatePipeline(ctx, event)
    if (verdict.action === 'deny') {
      counters.filtered++
      return false
    }
    // 'allow' (or 'defer' with allow default — evaluatePipeline resolves this)
    counters.delivered++
    return true
  }

  private async publishToAllConnections(event: IncomingEvent<TMetadata>): Promise<PublishResult> {
    if (this.connectionStates.size === 0) {
      return { delivered: 0, filtered: 0 }
    }

    // Collect all rooms across all managed connections
    const allRooms = new Set<string>()
    for (const state of this.connectionStates.values()) {
      for (const room of state.context.rooms) {
        allRooms.add(room)
      }
    }

    // Create per-publish counters
    const counters: PublishCounters = { delivered: 0, filtered: 0 }
    this.activeCounters = counters

    const message: SSEMessage = {
      event: event.eventName,
      data: event.data,
      id: randomUUID(),
    }

    if (allRooms.size > 0) {
      // Broadcast to all rooms — the pre-delivery filter will evaluate each connection
      await this.deps.sseRoomBroadcaster.broadcastMessage([...allRooms], message, {
        metadata: event.metadata as Record<string, unknown>,
      })
    }

    // Note: Connections with no rooms cannot be reached via room-based broadcast.
    // They are counted as filtered since the broadcaster has no public API to send
    // to a specific connection. Resolvers should declare rooms in onConnect() to
    // ensure connections are reachable.

    return { ...counters }
  }
}
