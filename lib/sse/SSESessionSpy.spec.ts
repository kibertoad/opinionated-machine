import { describe, expect, it } from 'vitest'
import { SSESessionSpy } from './SSESessionSpy.ts'

type TestSession = { id: string; request: { url: string } }

function fakeSession(id: string, url = '/stream'): TestSession {
  return { id, request: { url } }
}

describe('SSESessionSpy', () => {
  describe('waitForConnection timeout diagnostics', () => {
    it('reports a plain timeout when nothing ever connected', async () => {
      const spy = new SSESessionSpy<TestSession>()

      await expect(spy.waitForConnection({ timeout: 20 })).rejects.toThrow(
        /^Timeout waiting for connection after 20ms$/,
      )
    })

    it('explains a timeout caused by connections that already closed', async () => {
      const spy = new SSESessionSpy<TestSession>()
      // What an `autoClose` route looks like to the spy: registered and closed
      // before the test gets a chance to claim the session.
      spy.addConnection(fakeSession('conn-1'))
      spy.addDisconnection('conn-1')

      await expect(spy.waitForConnection({ timeout: 20 })).rejects.toThrow(
        /1 matching connection\(s\) were registered but had already closed: conn-1\..*autoClose/s,
      )
    })

    it('ignores closed connections that do not match the predicate', async () => {
      const spy = new SSESessionSpy<TestSession>()
      spy.addConnection(fakeSession('conn-1', '/other'))
      spy.addDisconnection('conn-1')

      await expect(
        spy.waitForConnection({
          timeout: 20,
          predicate: (connection) => connection.request.url === '/wanted',
        }),
      ).rejects.toThrow(/^Timeout waiting for connection after 20ms$/)
    })

    it('does not flag connections that are still active but already claimed', async () => {
      const spy = new SSESessionSpy<TestSession>()
      spy.addConnection(fakeSession('conn-1'))
      await spy.waitForConnection({ timeout: 20 })

      await expect(spy.waitForConnection({ timeout: 20 })).rejects.toThrow(
        /^Timeout waiting for connection after 20ms$/,
      )
    })
  })
})
