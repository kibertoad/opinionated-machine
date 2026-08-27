import type { SSESession } from '@lokalise/fastify-api-contracts'
import { describe, expect, it } from 'vitest'
import { SSERoomBroadcaster } from '../sse/rooms/SSERoomBroadcaster.ts'
import { SSERoomManager } from '../sse/rooms/SSERoomManager.ts'
import {
  getApiSseConnectionRegistry,
  getSessionRooms,
  withSessionRooms,
} from './apiSseConnectionRegistry.ts'

/**
 * A pending async `authorizeJoin` verdict is a window in which the connection
 * holds no membership yet but is about to. Every revocation path has to close
 * that window, or the resolved verdict re-adds the connection to a room it was
 * just removed from and the revocation silently does not stick.
 */

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} }

function fakeSession(id: string): SSESession {
  return {
    id,
    send: () => Promise.resolve(true),
    close: () => {},
    isConnected: () => true,
    request: { log: noopLogger },
  } as unknown as SSESession
}

type Deferred = { promise: Promise<boolean>; allow: () => void }

function deferredVerdict(): Deferred {
  let allow: (() => void) | undefined
  const promise = new Promise<boolean>((resolve) => {
    allow = () => resolve(true)
  })
  return { promise, allow: allow as () => void }
}

/** Wire a session into a broadcaster with an authorizer we control. */
function startSession(
  broadcaster: SSERoomBroadcaster,
  id: string,
  verdict: Promise<boolean>,
): SSESession {
  const options = withSessionRooms(
    { broadcaster, authorizeJoin: () => verdict },
    {} as Record<string, never>,
  ) as unknown as { onConnect: (session: SSESession) => void }
  const session = fakeSession(id)
  options.onConnect(session)
  return session
}

describe('withSessionRooms — pending async joins', () => {
  it('drops a pending join that evictFromRoom cancelled', async () => {
    const broadcaster = new SSERoomBroadcaster({ sseRoomManager: new SSERoomManager() })
    const registry = getApiSseConnectionRegistry(broadcaster)
    const verdict = deferredVerdict()
    const session = startSession(broadcaster, 'conn-1', verdict.promise)

    getSessionRooms(session).join('room:acme')
    // The verdict has not landed, so there is no membership to remove yet —
    // and that is exactly when the revocation used to be lost.
    expect(registry.evictFromRoom('room:acme', 'conn-1')).toBe(true)

    verdict.allow()
    await verdict.promise
    await Promise.resolve()

    expect(broadcaster.getConnectionCountInRoom('room:acme')).toBe(0)
  })

  it('drops a pending join that leave cancelled', async () => {
    const broadcaster = new SSERoomBroadcaster({ sseRoomManager: new SSERoomManager() })
    const verdict = deferredVerdict()
    const session = startSession(broadcaster, 'conn-1', verdict.promise)

    getSessionRooms(session).join('room:acme')
    getSessionRooms(session).leave('room:acme')

    verdict.allow()
    await verdict.promise
    await Promise.resolve()

    expect(broadcaster.getConnectionCountInRoom('room:acme')).toBe(0)
  })

  it('drops a pending join that an eviction cancelled', async () => {
    const broadcaster = new SSERoomBroadcaster({ sseRoomManager: new SSERoomManager() })
    const registry = getApiSseConnectionRegistry(broadcaster)
    const verdict = deferredVerdict()
    const session = startSession(broadcaster, 'conn-1', verdict.promise)

    getSessionRooms(session).join('room:acme')
    expect(registry.evict('conn-1')).toBe(true)

    verdict.allow()
    await verdict.promise
    await Promise.resolve()

    expect(broadcaster.getConnectionCountInRoom('room:acme')).toBe(0)
  })

  it('drops a pending join into a room that closeRoom revoked', async () => {
    const broadcaster = new SSERoomBroadcaster({ sseRoomManager: new SSERoomManager() })
    const registry = getApiSseConnectionRegistry(broadcaster)
    const verdict = deferredVerdict()
    const session = startSession(broadcaster, 'conn-1', verdict.promise)

    getSessionRooms(session).join('room:acme')
    // Nobody is in the room yet, so nothing is evicted — the pending join is
    // the only thing to revoke.
    expect(registry.closeRoom('room:acme')).toBe(0)

    verdict.allow()
    await verdict.promise
    await Promise.resolve()

    expect(broadcaster.getConnectionCountInRoom('room:acme')).toBe(0)
  })

  it('leaves an uncancelled pending join alone', async () => {
    const broadcaster = new SSERoomBroadcaster({ sseRoomManager: new SSERoomManager() })
    const registry = getApiSseConnectionRegistry(broadcaster)
    const verdict = deferredVerdict()
    const session = startSession(broadcaster, 'conn-1', verdict.promise)

    getSessionRooms(session).join('room:acme')
    // A revocation aimed at a different room must not swallow it.
    expect(registry.evictFromRoom('room:other', 'conn-1')).toBe(false)

    verdict.allow()
    await verdict.promise
    await Promise.resolve()

    expect(broadcaster.getConnectionCountInRoom('room:acme')).toBe(1)
  })
})
