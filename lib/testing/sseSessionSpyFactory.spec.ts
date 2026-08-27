import { describe, expect, it } from 'vitest'
import type { FastifySSERouteOptions, SSESession } from '../routes/index.ts'
import { createSSESessionSpy } from './sseSessionSpyFactory.ts'

type TestSession = { id: string; request: { url: string; method: string } }

function fakeSession(id: string, url = '/stream', method = 'GET'): TestSession {
  return { id, request: { url, method } }
}

describe('createSSESessionSpy', () => {
  it('feeds connections into the spy through onConnect', async () => {
    const { spy, routeOptions } = createSSESessionSpy<TestSession>()
    const session = fakeSession('conn-1')

    routeOptions.onConnect(session)

    await expect(spy.waitForConnection({ timeout: 50 })).resolves.toBe(session)
    expect(spy.isConnected('conn-1')).toBe(true)
  })

  it('feeds disconnections into the spy through onClose', async () => {
    const { spy, routeOptions } = createSSESessionSpy<TestSession>()
    const session = fakeSession('conn-1')

    routeOptions.onConnect(session)
    routeOptions.onClose(session, 'client')

    await spy.waitForDisconnection('conn-1', { timeout: 50 })
    expect(spy.isConnected('conn-1')).toBe(false)
    expect(spy.getEvents('conn-1').map((event) => event.type)).toEqual(['connect', 'disconnect'])
  })

  it('resolves a waiter registered before the connection arrives', async () => {
    const { spy, routeOptions } = createSSESessionSpy<TestSession>()
    const pending = spy.waitForConnection({
      timeout: 500,
      predicate: (connection) => connection.request.url === '/wanted',
    })

    routeOptions.onConnect(fakeSession('other', '/other'))
    const wanted = fakeSession('wanted', '/wanted')
    routeOptions.onConnect(wanted)

    await expect(pending).resolves.toBe(wanted)
  })

  it('gives each spy its own state', () => {
    const first = createSSESessionSpy<TestSession>()
    const second = createSSESessionSpy<TestSession>()

    first.routeOptions.onConnect(fakeSession('conn-1'))

    expect(first.spy.isConnected('conn-1')).toBe(true)
    expect(second.spy.isConnected('conn-1')).toBe(false)
  })

  it('runs the route own onConnect before notifying the spy, keeping both', async () => {
    const { spy, withSpy } = createSSESessionSpy<TestSession>()
    const seenByRoute: string[] = []
    const routeOptions = withSpy({
      onConnect: (connection) => {
        seenByRoute.push(connection.id)
      },
    })
    const session = fakeSession('conn-1')

    routeOptions.onConnect(session)

    expect(seenByRoute).toEqual(['conn-1'])
    await expect(spy.waitForConnection({ timeout: 50 })).resolves.toBe(session)
  })

  it('runs the route own onClose before notifying the spy, keeping both', async () => {
    const { spy, withSpy } = createSSESessionSpy<TestSession>()
    const closedByRoute: [string, string][] = []
    const routeOptions = withSpy({
      onClose: (connection, initiator) => {
        closedByRoute.push([connection.id, initiator])
      },
    })
    const session = fakeSession('conn-1')

    routeOptions.onConnect(session)
    routeOptions.onClose(session, 'client')

    expect(closedByRoute).toEqual([['conn-1', 'client']])
    await spy.waitForDisconnection('conn-1', { timeout: 50 })
    expect(spy.isConnected('conn-1')).toBe(false)
  })

  it('awaits an async route hook before notifying the spy', async () => {
    const { spy, withSpy } = createSSESessionSpy<TestSession>()
    const order: string[] = []
    const routeOptions = withSpy({
      onConnect: async (connection) => {
        await Promise.resolve()
        order.push(`route:${connection.id}`)
      },
    })
    const session = fakeSession('conn-1')

    const pending = spy
      .waitForConnection({ timeout: 500 })
      .then((connection) => order.push(`spy:${connection.id}`))

    await routeOptions.onConnect(session)
    await pending

    expect(order).toEqual(['route:conn-1', 'spy:conn-1'])
  })

  it('still notifies the spy when the route hook fails, and rethrows', async () => {
    const { spy, withSpy } = createSSESessionSpy<TestSession>()
    const boom = new Error('route hook exploded')
    const syncRouteOptions = withSpy({
      onConnect: () => {
        throw boom
      },
    })
    const asyncRouteOptions = withSpy({
      onConnect: () => Promise.reject(boom),
    })

    expect(() => syncRouteOptions.onConnect(fakeSession('sync'))).toThrow(boom)
    await expect(asyncRouteOptions.onConnect(fakeSession('async'))).rejects.toThrow(boom)

    expect(spy.isConnected('sync')).toBe(true)
    expect(spy.isConnected('async')).toBe(true)
  })

  it('passes non-hook options through untouched', () => {
    const { withSpy } = createSSESessionSpy<TestSession>()

    const routeOptions = withSpy({ heartbeat: false, serializer: JSON.stringify })

    expect(routeOptions.heartbeat).toBe(false)
    expect(routeOptions.serializer).toBe(JSON.stringify)
    expect(routeOptions.onConnect).toBeTypeOf('function')
    expect(routeOptions.onClose).toBeTypeOf('function')
  })

  it('produces route options accepted by this package own SSE route options', () => {
    // Type-level check: the escape hatch for `buildFastifyRoute`-built routes.
    const { routeOptions, withSpy } = createSSESessionSpy<SSESession>()
    const sseRouteOptions: FastifySSERouteOptions = { ...routeOptions }
    const composedRouteOptions: FastifySSERouteOptions = withSpy({
      heartbeat: false,
      onConnect: (connection) => void connection.id,
    })

    expect(sseRouteOptions.onConnect).toBeDefined()
    expect(sseRouteOptions.onClose).toBeDefined()
    expect(composedRouteOptions.heartbeat).toBe(false)
  })
})
