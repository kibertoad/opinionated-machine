import { describe, expect, it } from 'vitest'
import type { FastifySSERouteOptions, SSESession } from '../routes/index.ts'
import { createSSESessionSpy } from './sseSessionSpyFactory.ts'

type TestSession = { id: string; request: { url: string } }

function fakeSession(id: string, url = '/stream'): TestSession {
  return { id, request: { url } }
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

  it('produces route options accepted by this package own SSE route options', () => {
    // Type-level check: the escape hatch for `buildFastifyRoute`-built routes.
    const { routeOptions } = createSSESessionSpy<SSESession>()
    const sseRouteOptions: FastifySSERouteOptions = { ...routeOptions }

    expect(sseRouteOptions.onConnect).toBeDefined()
    expect(sseRouteOptions.onClose).toBeDefined()
  })
})
