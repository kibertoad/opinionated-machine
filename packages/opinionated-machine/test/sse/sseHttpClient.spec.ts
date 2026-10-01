import { setTimeout as delay } from 'node:timers/promises'
import { defineApiContract, sseBody } from '@lokalise/api-contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import {
  buildApiRoute,
  type CreateSSESessionSpyResult,
  createSSESessionSpy,
  SSEHttpClient,
} from '../../index.js'
import { startSSEStreamTestApp } from '../api-contracts/fixtures/sseStreamTestApp.ts'
import type { SSETestServerWithResources } from '../sseTestServerFactory.js'

const clientStreamContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Keep-alive stream the test drives through the server-side session',
  pathResolver: () => '/api/client/stream',
  responsesByStatusCode: {
    200: {
      content: {
        'text/event-stream': sseBody({
          tick: z.object({ seq: z.number() }),
          done: z.object({ seq: z.number() }),
        }),
      },
    },
  },
})

const STREAM_PATH = clientStreamContract.pathResolver()

/**
 * Tests for SSEHttpClient edge cases and error handling.
 *
 * The route only opens a keep-alive session; every event is pushed from the test through the
 * server-side session resolved by the spy, so the timing of each event is under test control.
 */
describe('SSEHttpClient', () => {
  let server: SSETestServerWithResources<undefined>
  let spy: CreateSSESessionSpyResult['spy']
  let openClients: SSEHttpClient[]

  beforeEach(async () => {
    openClients = []
    const sessionSpy = createSSESessionSpy()
    spy = sessionSpy.spy

    server = await startSSEStreamTestApp((app) => {
      app.route(
        buildApiRoute(
          clientStreamContract,
          (_request, _reply, { sse }) => {
            sse.start('keepAlive')
          },
          sessionSpy.routeOptions,
        ),
      )
    })
  })

  afterEach(async () => {
    for (const client of openClients) {
      client.close()
    }
    await server.close()
  })

  async function connect() {
    const result = await SSEHttpClient.connect(server.baseUrl, STREAM_PATH, {
      awaitServerConnection: { spy },
    })
    openClients.push(result.client)
    return result
  }

  describe('collectEvents', () => {
    it('throws a timeout error when no events arrive within the timeout', async () => {
      const { client } = await connect()

      await expect(client.collectEvents(1, 100)).rejects.toThrow(
        'Timeout collecting events (got 0)',
      )
    })

    it('throws a timeout error for a zero timeout when no event is buffered', async () => {
      const { client } = await connect()

      await expect(client.collectEvents(1, 0)).rejects.toThrow('Timeout collecting events (got 0)')
    })

    it('collects events until the predicate matches, including the matching event', async () => {
      const { client, serverConnection } = await connect()

      const eventsPromise = client.collectEvents((event) => event.event === 'done', 5000)

      await serverConnection.send('tick', { seq: 1 })
      await serverConnection.send('tick', { seq: 2 })
      await serverConnection.send('done', { seq: 3 })

      const events = await eventsPromise
      expect(events.map((event) => event.event)).toEqual(['tick', 'tick', 'done'])
    })

    it('continues from where the previous call stopped on the same client', async () => {
      const { client, serverConnection } = await connect()

      const firstPromise = client.collectEvents(2, 5000)
      await serverConnection.send('tick', { seq: 1 })
      await serverConnection.send('tick', { seq: 2 })
      const firstEvents = await firstPromise

      const secondPromise = client.collectEvents(2, 5000)
      await serverConnection.send('tick', { seq: 3 })
      await serverConnection.send('tick', { seq: 4 })
      const secondEvents = await secondPromise

      expect(firstEvents.map((event) => JSON.parse(event.data).seq)).toEqual([1, 2])
      expect(secondEvents.map((event) => JSON.parse(event.data).seq)).toEqual([3, 4])
    })
  })

  describe('events() with AbortSignal', () => {
    it('stops the generator when the signal fires', async () => {
      const { client, serverConnection } = await connect()

      const abortController = new AbortController()
      const collected: number[] = []

      const consumePromise = (async () => {
        for await (const event of client.events(abortController.signal)) {
          collected.push(JSON.parse(event.data).seq)
          if (collected.length === 2) {
            abortController.abort()
          }
        }
      })()

      for (let seq = 1; seq <= 5; seq++) {
        await serverConnection.send('tick', { seq })
        await delay(10)
      }

      await consumePromise

      expect(collected).toEqual([1, 2])
    })

    it('yields nothing for an already-aborted signal', async () => {
      const { client, serverConnection } = await connect()
      await serverConnection.send('tick', { seq: 1 })

      const abortController = new AbortController()
      abortController.abort()

      const collected: unknown[] = []
      for await (const event of client.events(abortController.signal)) {
        collected.push(event)
      }

      expect(collected).toHaveLength(0)
    })
  })

  describe('resource cleanup', () => {
    it('close() after a collectEvents timeout does not cause an unhandled rejection', async () => {
      const { client } = await connect()

      // Times out while a read is still pending on the stream
      await expect(client.collectEvents(1, 50)).rejects.toThrow('Timeout collecting events')

      client.close()

      // Give any unhandled rejection time to surface - vitest fails the run on one
      await delay(50)
    })

    it('close() after collectEvents stopped early does not cause an unhandled rejection', async () => {
      const { client, serverConnection } = await connect()

      const eventsPromise = client.collectEvents(2, 5000)
      for (let seq = 1; seq <= 5; seq++) {
        await serverConnection.send('tick', { seq })
      }

      const events = await eventsPromise
      expect(events).toHaveLength(2)

      client.close()

      await delay(50)
    })
  })
})
