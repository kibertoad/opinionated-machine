import { describe, expect, it, vi } from 'vitest'
import { InMemoryAdapter } from './InMemoryAdapter.js'

describe('InMemoryAdapter', () => {
  it('should implement connect as no-op', async () => {
    const adapter = new InMemoryAdapter()
    await expect(adapter.connect()).resolves.toBeUndefined()
  })

  it('should implement disconnect as no-op', async () => {
    const adapter = new InMemoryAdapter()
    await expect(adapter.disconnect()).resolves.toBeUndefined()
  })

  it('should implement subscribe as no-op', async () => {
    const adapter = new InMemoryAdapter()
    await expect(adapter.subscribe('room-a')).resolves.toBeUndefined()
  })

  it('should implement unsubscribe as no-op', async () => {
    const adapter = new InMemoryAdapter()
    await expect(adapter.unsubscribe('room-a')).resolves.toBeUndefined()
  })

  it('should implement publish as no-op', async () => {
    const adapter = new InMemoryAdapter()
    await expect(adapter.publish('room-a', { event: 'test', data: {} })).resolves.toBeUndefined()
  })

  it('should store message handler via onMessage', () => {
    const adapter = new InMemoryAdapter()
    const handler = vi.fn()

    adapter.onMessage(handler)

    // Handler is stored but never invoked since InMemoryAdapter is a no-op
    // This test verifies the method doesn't throw
    expect(handler).not.toHaveBeenCalled()
  })
})
