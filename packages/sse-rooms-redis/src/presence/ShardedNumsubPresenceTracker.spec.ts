import { describe, expect, it, vi } from 'vitest'
import { ShardedNumsubPresenceTracker } from './ShardedNumsubPresenceTracker.ts'
import type { NumsubCapableClient } from './types.ts'

type MockedCall = NonNullable<NumsubCapableClient['call']> & ReturnType<typeof vi.fn>
type MockedSendCommand = NonNullable<NumsubCapableClient['sendCommand']> & ReturnType<typeof vi.fn>

type IoredisStyleMock = { call: MockedCall }
type NodeRedisStyleMock = { sendCommand: MockedSendCommand }

function makeIoredisClient(): IoredisStyleMock {
  return { call: vi.fn() as MockedCall }
}

function makeNodeRedisClient(): NodeRedisStyleMock {
  return { sendCommand: vi.fn() as MockedSendCommand }
}

describe('ShardedNumsubPresenceTracker', () => {
  it('issues PUBSUB SHARDNUMSUB via ioredis call', async () => {
    const client = makeIoredisClient()
    client.call.mockResolvedValue(['sse:room:room-a', 2])
    const tracker = new ShardedNumsubPresenceTracker({ client })

    const result = await tracker.hasSubscribers('room-a')

    expect(result).toBe(true)
    expect(client.call).toHaveBeenCalledWith('PUBSUB', 'SHARDNUMSUB', 'sse:room:room-a')
  })

  it('issues PUBSUB SHARDNUMSUB via node-redis sendCommand', async () => {
    const client = makeNodeRedisClient()
    client.sendCommand.mockResolvedValue(['sse:room:room-a', 1])
    const tracker = new ShardedNumsubPresenceTracker({ client })

    const result = await tracker.hasSubscribers('room-a')

    expect(result).toBe(true)
    expect(client.sendCommand).toHaveBeenCalledWith(['PUBSUB', 'SHARDNUMSUB', 'sse:room:room-a'])
  })

  it('returns false when SHARDNUMSUB reports zero', async () => {
    const client = makeIoredisClient()
    client.call.mockResolvedValue(['sse:room:room-a', 0])
    const tracker = new ShardedNumsubPresenceTracker({ client })

    expect(await tracker.hasSubscribers('room-a')).toBe(false)
  })

  it('shares all caching behaviour with the classic tracker (smoke test)', async () => {
    // Full caching/LRU semantics are covered by NumsubPresenceTracker.spec.ts.
    // This is a sanity check that the inherited cache also works for the
    // sharded variant.
    const client = makeIoredisClient()
    client.call.mockResolvedValue(['sse:room:room-a', 1])
    const tracker = new ShardedNumsubPresenceTracker({ client })

    await tracker.hasSubscribers('room-a')
    await tracker.hasSubscribers('room-a')

    expect(client.call).toHaveBeenCalledTimes(1)
  })
})
