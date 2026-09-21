import { InternalError } from '@lokalise/node-core'
import type { z } from 'zod'
import type { SSEEventDefinition } from '../defineEvent.js'
import type { SSELogger } from '../sseTypes.js'
import type { SSERoomBroadcaster } from './SSERoomBroadcaster.js'
import type { RoomBroadcastOptions } from './types.js'

export type SSERoomEventPublisherDependencies = {
  sseRoomBroadcaster: SSERoomBroadcaster
  logger: SSELogger
}

/**
 * Whatever the caller is working on behalf of, narrowed to the one thing the publisher needs
 * from it. `@lokalise/fastify-extras`' `RequestContext` satisfies this structurally, as does a
 * job or consumer context of your own, so neither this package nor its callers need an adapter.
 */
export type SSELogContext = {
  logger: SSELogger
}

/**
 * Everything {@link SSERoomBroadcaster.broadcastToRoom} accepts, so the publisher is not a lossy
 * wrapper over it.
 */
export type SSERoomEventPublishOptions = RoomBroadcastOptions & {
  /**
   * The SSE `id:` put on the wire. Defaults to a random UUID. Set it to a value a client can
   * order, such as the sequence from `createEventIdSequence()`, when consumers deduplicate or
   * resume by event id.
   */
  id?: string
  /** The SSE `retry:` hint, in milliseconds: how long a client waits before reconnecting. */
  retry?: number
  /**
   * Per-broadcast context handed to the pre-delivery filter, and to other nodes alongside the
   * message. Only a filter reads it (`SSESubscriptionManager` installs one to evaluate its
   * resolver pipeline), so it is redundant unless one is installed.
   */
  metadata?: Record<string, unknown>
}

/**
 * Fire-and-forget broadcasting for domain code: a room event goes out and the caller does not
 * await the fan-out.
 *
 * The typical producer is an event listener or a message handler whose primary work has already
 * committed. It cannot retry a dropped hint, and awaiting the fan-out would tie its latency to
 * the number of open connections. Code that needs the delivered count, or that can act on a
 * delivery failure, should use {@link SSERoomBroadcaster} directly.
 *
 * The two ways publishing fails are treated differently, because they are different kinds of
 * problem:
 *
 * - **A payload that violates its own event schema is a bug in the producer.** Nobody receives
 *   the event, so swallowing it means believing you published something you did not.
 *   {@link publish} throws. {@link safePublish} logs instead, for a caller that cannot absorb a
 *   throw.
 * - **A failed broadcast is the world's problem**, and no caller here can retry it, so both
 *   methods log it. It also happens after the call has returned, which is why neither method can
 *   report it in a return value.
 *
 * @example
 * ```typescript
 * // In your DI module
 * sseRoomEventPublisher: asSingletonClass(SSERoomEventPublisher),
 *
 * // In a listener. `requestContext` is passed straight through: the publisher reads its
 * // logger, so a dropped event carries the correlation id of whatever produced it.
 * this.publisher.publish(
 *   ProjectSse.roomResolver(projectId),
 *   ProjectSse.events.updated,
 *   payload,
 *   requestContext,
 * )
 * ```
 */
export class SSERoomEventPublisher {
  private readonly sseRoomBroadcaster: SSERoomBroadcaster
  private readonly logger: SSELogger

  constructor({ sseRoomBroadcaster, logger }: SSERoomEventPublisherDependencies) {
    this.sseRoomBroadcaster = sseRoomBroadcaster
    this.logger = logger
  }

  /**
   * Validate `data` against the event's own schema and broadcast it to `room`, throwing if it
   * fails.
   *
   * Validating here rather than leaving it to delivery is what makes the throw possible at all.
   * Delivery-time validation runs once per connection, so it reports a mismatch once per open
   * connection on every node, names the event but not the code that produced it, and does not
   * run at all when nobody has joined the room. By then the call has long returned and there is
   * nothing left to throw to.
   *
   * What goes on the wire is the parsed value, so a schema default is filled in once here
   * instead of being left to every client. Delivery-time validation discards its own result and
   * serializes what it was handed, so calling {@link SSERoomBroadcaster.broadcastToRoom}
   * directly sends the unparsed input.
   *
   * `context` is whatever the caller is acting on behalf of; only its logger is read, so a
   * request context goes in as-is. Omit it in a caller that has none and the injected logger is
   * used, which costs a logged failure its correlation id and nothing else.
   *
   * @throws {InternalError} if `data` does not satisfy the event's schema.
   */
  publish<T extends z.ZodType>(
    room: string | string[],
    event: SSEEventDefinition<string, T>,
    data: z.input<T>,
    context?: SSELogContext,
    options?: SSERoomEventPublishOptions,
  ): void {
    const validation = event.schema.safeParse(data)

    if (!validation.success) {
      throw new InternalError({
        message: `SSE event validation failed for event "${event.event}": ${validation.error.message}`,
        errorCode: 'SSE_EVENT_VALIDATION_FAILED',
        details: { room: Array.isArray(room) ? room.join(',') : room, event: event.event },
      })
    }

    this.broadcast(room, event, validation.data, context, options)
  }

  /**
   * {@link publish}, but a payload that fails its schema is logged and dropped rather than
   * thrown.
   *
   * For a producer that cannot absorb a throw: a message handler whose primary work has already
   * committed would be retried in full and redo it, and the retry cannot succeed anyway, since a
   * malformed payload fails the same way every time. Prefer {@link publish} everywhere else. A
   * swallowed contract violation means believing an event went out when nothing did.
   */
  safePublish<T extends z.ZodType>(
    room: string | string[],
    event: SSEEventDefinition<string, T>,
    data: z.input<T>,
    context?: SSELogContext,
    options?: SSERoomEventPublishOptions,
  ): void {
    const validation = event.schema.safeParse(data)

    if (!validation.success) {
      const logger = context?.logger ?? this.logger
      logger.error(
        { room, event: event.event, issues: validation.error.issues },
        'Refusing to broadcast an SSE event that fails its own schema',
      )
      return
    }

    this.broadcast(room, event, validation.data, context, options)
  }

  /**
   * The shared tail of both methods. A failed broadcast is logged rather than surfaced: it
   * happens after the caller has returned, and none of these callers could retry it anyway.
   */
  private broadcast<T extends z.ZodType>(
    room: string | string[],
    event: SSEEventDefinition<string, T>,
    // Already schema-valid, so the re-parse at delivery accepts it. The cast below is only
    // needed because `z.output` is not `z.input` for a schema that defaults or transforms.
    parsed: z.output<T>,
    context: SSELogContext | undefined,
    options: SSERoomEventPublishOptions | undefined,
  ): void {
    const logger = context?.logger ?? this.logger

    this.sseRoomBroadcaster
      .broadcastToRoom(room, event, parsed as z.input<T>, options)
      .catch((error: unknown) => {
        logger.error({ error, room, event: event.event }, 'Failed to broadcast SSE event')
      })
  }
}
