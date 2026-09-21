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
 * Everything {@link SSERoomBroadcaster.broadcastToRoom} accepts, so the publisher is not a lossy
 * wrapper over it, plus a per-call logger.
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
  /**
   * Logger for this call, overriding the injected one. Pass the request-scoped logger where the
   * caller has one, so a dropped event carries the correlation id of the message or request that
   * produced it.
   */
  logger?: SSELogger
}

/**
 * Fire-and-forget broadcasting for domain code: a room event is published, and a failure is
 * logged rather than returned.
 *
 * The typical producer is an event listener or a message handler whose primary work has already
 * committed. It cannot retry a dropped hint and has nowhere to report one, and awaiting the
 * fan-out would tie its latency to the number of open connections. Those callers want
 * {@link SSERoomBroadcaster} without the promise; code that needs the delivered count, or that
 * can act on a failure, should keep using the broadcaster directly.
 *
 * @example
 * ```typescript
 * // In your DI module
 * sseRoomEventPublisher: asSingletonClass(SSERoomEventPublisher),
 *
 * // In a listener
 * this.publisher.publish(ProjectSse.roomResolver(projectId), ProjectSse.events.updated, payload, {
 *   logger: requestContext.logger,
 * })
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
   * Validate `data` against the event's own schema and broadcast it to `room`.
   *
   * A payload that fails its schema is refused here rather than at delivery. Delivery-time
   * validation runs once per connection, so it reports a mismatch once per open connection on
   * every node, naming the event but not the code that produced it, and a room nobody has
   * joined validates nothing at all. Checking up front reduces that to one log line, at the
   * producer, naming the failing field, whether or not anyone is listening.
   *
   * What goes on the wire is the parsed value, so a schema default is filled in once here
   * instead of being left to every client. Delivery-time validation discards its own result and
   * serializes what it was handed, so calling {@link SSERoomBroadcaster.broadcastToRoom}
   * directly sends the unparsed input.
   */
  publish<T extends z.ZodType>(
    room: string | string[],
    event: SSEEventDefinition<string, T>,
    data: z.input<T>,
    options?: SSERoomEventPublishOptions,
  ): void {
    const logger = options?.logger ?? this.logger

    const validation = event.schema.safeParse(data)
    if (!validation.success) {
      logger.error(
        { room, event: event.event, issues: validation.error.issues },
        'Refusing to broadcast an SSE event that fails its own schema',
      )
      return
    }

    // Already schema-valid, so the re-parse at delivery accepts it; the cast is only needed
    // because `z.output` is not `z.input` for a schema that defaults or transforms.
    const parsed = validation.data as z.input<T>

    this.sseRoomBroadcaster
      .broadcastToRoom(room, event, parsed, options)
      .catch((error: unknown) => {
        logger.error({ error, room, event: event.event }, 'Failed to broadcast SSE event')
      })
  }
}
