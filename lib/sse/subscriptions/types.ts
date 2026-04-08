import type { FastifyRequest } from 'fastify'
import type { SSELogger } from '../sseTypes.js'

/**
 * Immutable context available to every resolver during evaluation.
 * Replaced (never mutated) on connect and refresh.
 */
export type SubscriptionContext<TUserContext> = Readonly<{
  /** Unique connection identifier */
  connectionId: string
  /** The original HTTP request (headers, auth, params) */
  request: FastifyRequest
  /** Application-defined per-user data (userId, roles, cached memberships, etc.) */
  userContext: Readonly<TUserContext>
  /** All rooms this connection is currently in (union across all resolvers) */
  rooms: ReadonlySet<string>
}>

/**
 * Event being evaluated by the resolver pipeline.
 *
 * @template TMetadata - Discriminated union of event metadata shapes
 */
export type IncomingEvent<TMetadata extends Record<string, unknown> = Record<string, unknown>> = {
  /** Event name (maps to SSE `event` field) */
  eventName: string
  /** Event payload (delivered to client as SSE data) */
  data: unknown
  /** Rooms the event targets (used for pre-filtering and cross-node propagation) */
  targetRooms?: string[]
  /** Typed event metadata for resolver filtering decisions (not delivered to clients) */
  metadata: TMetadata
}

/**
 * A resolver's decision about whether an event should reach a connection.
 *
 * - `allow`: This resolver approves delivery (subsequent resolvers can still deny)
 * - `deny`: Short-circuits — event is NOT delivered to this connection
 * - `defer`: This resolver has no opinion — continue to the next resolver
 */
export type FilterVerdict =
  | { action: 'allow' }
  | { action: 'deny'; reason?: string }
  | { action: 'defer' }

/**
 * Returned by onConnect() and refresh() — declares updated user context
 * and room requirements. The manager diffs rooms and joins/leaves as needed.
 */
export type ResolverResult<TUserContext> = {
  /** Updated (immutable) user context — full replacement, not a merge */
  userContext: TUserContext
  /** Rooms this resolver requires. Manager diffs against previous set. */
  rooms?: string[]
}

/**
 * A single filter in the resolver pipeline.
 *
 * Resolvers are stateless — all per-connection state lives in `userContext`.
 * They are evaluated in array order. First `deny` short-circuits.
 *
 * @template TUserContext - Application-defined per-connection context
 * @template TMetadata - Discriminated union of event metadata shapes
 */
export interface SubscriptionResolver<
  TUserContext = unknown,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Unique resolver name (used in logging and debugging) */
  readonly name: string

  /**
   * Called once when a connection is established.
   * Hydrate user context and declare initial room memberships.
   *
   * Resolvers run in array order. Each resolver receives the accumulated
   * `userContext` from all prior resolvers — use spread to preserve it.
   *
   * If this method throws, `handleConnect()` rejects and the connection
   * is not tracked by the subscription manager.
   */
  onConnect?(
    ctx: SubscriptionContext<TUserContext>,
  ): ResolverResult<TUserContext> | Promise<ResolverResult<TUserContext>>

  /**
   * Evaluate whether an event should be delivered to this connection.
   * Must be fast — runs for every (event × connection) pair.
   */
  evaluate(
    ctx: SubscriptionContext<TUserContext>,
    event: IncomingEvent<TMetadata>,
  ): FilterVerdict | Promise<FilterVerdict>

  /**
   * Re-hydrate user context and room memberships.
   * Called when external state changes (e.g., user updates preferences).
   * Manager diffs the returned rooms against the previous set.
   *
   * If this method throws, the error is logged and this resolver keeps
   * its previous state (rooms + context). Other resolvers continue refreshing.
   */
  refresh?(
    ctx: SubscriptionContext<TUserContext>,
  ): ResolverResult<TUserContext> | Promise<ResolverResult<TUserContext>>
}

/**
 * Configuration for the SSE Subscription Manager.
 *
 * @template TUserContext - Application-defined per-connection context
 * @template TMetadata - Discriminated union of event metadata shapes
 */
export type SSESubscriptionManagerConfig<
  TUserContext,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> = {
  /**
   * Extract initial user context from the HTTP request.
   * Runs once per connection before resolvers' onConnect.
   */
  resolveUserContext: (request: FastifyRequest) => Promise<TUserContext>

  /**
   * Ordered resolver pipeline. Evaluated in array order.
   * First `deny` short-circuits. If all `defer`, defaultPolicy applies.
   */
  resolvers: SubscriptionResolver<TUserContext, TMetadata>[]

  /**
   * What happens when all resolvers return `defer`.
   * @default 'deny'
   */
  defaultPolicy?: 'allow' | 'deny'

  /**
   * Extract userId from user context. Required for `refreshUser()`.
   * If not provided, `refreshUser()` throws.
   */
  resolveUserId?: (userContext: TUserContext) => string

  /**
   * Optional logger for resolver verdicts and room operations.
   */
  logger?: SSELogger
}

/**
 * Result of a publish operation.
 */
export type PublishResult = {
  /** Number of connections the event was delivered to */
  delivered: number
  /** Number of connections that were filtered out by resolvers */
  filtered: number
}
