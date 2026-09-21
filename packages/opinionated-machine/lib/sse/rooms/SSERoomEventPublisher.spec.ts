import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defineEvent } from '../defineEvent.js'
import type { SSELogger, SSEMessage } from '../sseTypes.js'
import { SSERoomBroadcaster } from './SSERoomBroadcaster.js'
import { SSERoomEventPublisher } from './SSERoomEventPublisher.js'
import { SSERoomManager } from './SSERoomManager.js'
import type { SSERoomAdapter } from './types.js'

const THING_UPDATED = defineEvent('thing.updated', z.object({ id: z.string().uuid() }))

const ROOM = 'thing:1'
const VALID_PAYLOAD = { id: '0199c3b4-0000-7000-8000-000000000001' }

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

describe('SSERoomEventPublisher', () => {
  let roomManager: SSERoomManager
  let sendEvent: ReturnType<
    typeof vi.fn<(connectionId: string, message: SSEMessage) => Promise<boolean>>
  >
  let broadcaster: SSERoomBroadcaster
  let logger: SSELogger
  let error: ReturnType<typeof vi.fn<SSELogger['error']>>
  let publisher: SSERoomEventPublisher

  beforeEach(() => {
    roomManager = new SSERoomManager({ adapter: createMockAdapter() })
    sendEvent = vi.fn().mockResolvedValue(true)
    broadcaster = new SSERoomBroadcaster({ sseRoomManager: roomManager })
    broadcaster.registerSender(sendEvent)
    error = vi.fn<SSELogger['error']>()
    logger = { error }
    publisher = new SSERoomEventPublisher({ sseRoomBroadcaster: broadcaster, logger })
  })

  it('broadcasts a payload that satisfies the event schema', async () => {
    roomManager.join('conn-1', ROOM)

    publisher.publish(ROOM, THING_UPDATED, VALID_PAYLOAD)

    await vi.waitFor(() => expect(sendEvent).toHaveBeenCalledTimes(1))
    expect(sendEvent).toHaveBeenCalledWith(
      'conn-1',
      expect.objectContaining({ event: 'thing.updated', data: VALID_PAYLOAD }),
    )
    expect(error).not.toHaveBeenCalled()
  })

  // Delivery-time validation discards its own result and serializes what it was handed, so a
  // default only reaches the wire if the publisher substitutes the parsed value here.
  it('broadcasts the parsed value, so a schema default is on the wire', async () => {
    const thingCreated = defineEvent(
      'thing.created',
      z.object({ id: z.string(), source: z.string().default('api') }),
    )
    roomManager.join('conn-1', ROOM)

    publisher.publish(ROOM, thingCreated, { id: 'thing-1' })

    await vi.waitFor(() => expect(sendEvent).toHaveBeenCalledTimes(1))
    expect(sendEvent).toHaveBeenCalledWith(
      'conn-1',
      expect.objectContaining({ data: { id: 'thing-1', source: 'api' } }),
    )
  })

  it('refuses a payload that fails the event schema', () => {
    roomManager.join('conn-1', ROOM)

    publisher.publish(ROOM, THING_UPDATED, { id: 'not-a-uuid' })

    expect(sendEvent).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ room: ROOM, event: 'thing.updated' }),
      'Refusing to broadcast an SSE event that fails its own schema',
    )
  })

  // Delivery-time validation only runs per connection, so an empty room would let a malformed
  // payload reach the adapter unremarked.
  it('refuses a payload that fails its schema even when the room is empty', () => {
    publisher.publish(ROOM, THING_UPDATED, { id: 'not-a-uuid' })

    expect(error).toHaveBeenCalledTimes(1)
  })

  it('logs a rejected broadcast rather than surfacing it to the caller', async () => {
    roomManager.join('conn-1', ROOM)
    sendEvent.mockRejectedValue(new Error('connection is gone'))

    expect(() => publisher.publish(ROOM, THING_UPDATED, VALID_PAYLOAD)).not.toThrow()

    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ room: ROOM, event: 'thing.updated' }),
        'Failed to broadcast SSE event',
      ),
    )
  })

  // A `RequestContext` goes in whole: the publisher reads its logger and ignores the rest, so
  // callers hand over the context they already hold rather than picking it apart.
  it('logs through the context logger when a context is given', () => {
    const requestScopedError = vi.fn<SSELogger['error']>()
    // Shaped like a `RequestContext`: fields beyond `logger` are along for the ride.
    const requestContext = { logger: { error: requestScopedError }, reqId: 'req-1' }

    publisher.publish(ROOM, THING_UPDATED, { id: 'not-a-uuid' }, requestContext)

    expect(requestScopedError).toHaveBeenCalledTimes(1)
    expect(error).not.toHaveBeenCalled()
  })

  it('passes broadcast options through to the broadcaster', async () => {
    roomManager.join('conn-1', ROOM)

    publisher.publish(ROOM, THING_UPDATED, VALID_PAYLOAD, undefined, {
      id: 'msg-1',
      retry: 5000,
    })

    await vi.waitFor(() =>
      expect(sendEvent).toHaveBeenCalledWith(
        'conn-1',
        expect.objectContaining({ id: 'msg-1', retry: 5000 }),
      ),
    )
  })
})
