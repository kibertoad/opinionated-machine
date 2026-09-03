import type { SSESession } from '@lokalise/fastify-api-contracts'
import { describe, expect, it } from 'vitest'
import { SSERoomBroadcaster } from '../sse/rooms/SSERoomBroadcaster.ts'
import { SSERoomManager } from '../sse/rooms/SSERoomManager.ts'
import type { ApiSseConnectionRegistry, PendingJoin } from './apiSseConnectionRegistry.ts'
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

/**
 * A verdict that never settles never runs `settlePendingJoin`, which is the
 * only place the map entry is removed on the happy path. Teardown has to drop
 * the entry itself, or every such connection leaks its id and its tokens.
 */
describe('ApiSseConnectionRegistry — pending join bookkeeping', () => {
  function pendingJoinsOf(registry: ApiSseConnectionRegistry): Map<string, PendingJoin[]> {
    return (registry as unknown as { pendingJoins: Map<string, PendingJoin[]> }).pendingJoins
  }

  it('forgets a never-settling join when the connection unregisters', async () => {
    const broadcaster = new SSERoomBroadcaster({ sseRoomManager: new SSERoomManager() })
    const registry = getApiSseConnectionRegistry(broadcaster)
    const session = startSession(broadcaster, 'conn-1', new Promise<boolean>(() => {}))

    getSessionRooms(session).join('room:acme')
    expect(pendingJoinsOf(registry).size).toBe(1)

    registry.unregister('conn-1')

    expect(pendingJoinsOf(registry).size).toBe(0)
    await Promise.resolve()
    expect(broadcaster.getConnectionCountInRoom('room:acme')).toBe(0)
  })

  it('forgets a never-settling join when the connection is evicted', async () => {
    const broadcaster = new SSERoomBroadcaster({ sseRoomManager: new SSERoomManager() })
    const registry = getApiSseConnectionRegistry(broadcaster)
    const session = startSession(broadcaster, 'conn-1', new Promise<boolean>(() => {}))

    getSessionRooms(session).join('room:acme')
    expect(registry.evict('conn-1')).toBe(true)

    expect(pendingJoinsOf(registry).size).toBe(0)
    await Promise.resolve()
    expect(broadcaster.getConnectionCountInRoom('room:acme')).toBe(0)
  })

  it('still drops a verdict that lands after the entry was forgotten', async () => {
    const broadcaster = new SSERoomBroadcaster({ sseRoomManager: new SSERoomManager() })
    const registry = getApiSseConnectionRegistry(broadcaster)
    const verdict = deferredVerdict()
    const session = startSession(broadcaster, 'conn-1', verdict.promise)

    getSessionRooms(session).join('room:acme')
    registry.unregister('conn-1')

    verdict.allow()
    await verdict.promise
    await Promise.resolve()

    // Cancellation rides on the token the join closure captured, so dropping
    // the map entry does not resurrect the revoked join.
    expect(broadcaster.getConnectionCountInRoom('room:acme')).toBe(0)
    expect(pendingJoinsOf(registry).size).toBe(0)
  })
})
