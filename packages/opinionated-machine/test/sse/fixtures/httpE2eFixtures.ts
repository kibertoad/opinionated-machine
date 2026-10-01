import { defineApiContract, sseBody } from '@lokalise/api-contracts'
import { parse as parseQueryString } from 'fast-querystring'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import { type ApiRouteOptions, buildApiRoute } from '../../../lib/api-contracts/index.ts'
import type { CreateSSESessionSpyResult } from '../../../lib/testing/index.ts'
import type { HandlerGate } from '../../api-contracts/fixtures/sseStreamTestApp.ts'

/**
 * Routes for the real-HTTP `SSEHttpClient` suite (`sse.http.e2e.spec.ts`).
 */

/** Payload covering the JSON shapes that have to survive SSE framing intact. */
export const serializationPayloadSchema = z.object({
  message: z.string(),
  metadata: z.object({
    nested: z.object({ deeply: z.object({ value: z.number(), array: z.array(z.number()) }) }),
    tags: z.array(z.string()),
  }),
  optionalField: z.null(),
  integer: z.number(),
  float: z.number(),
  negative: z.number(),
  scientific: z.number(),
  isActive: z.boolean(),
  isDeleted: z.boolean(),
})

/** keepAlive GET stream the test drives through the session the spy hands back. */
export const notificationsStreamContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Long-lived notifications stream',
  pathResolver: () => '/api/notifications/stream',
  requestQuerySchema: z.object({ userId: z.string() }),
  responsesByStatusCode: {
    200: {
      content: {
        'text/event-stream': sseBody({
          notification: z.object({ id: z.string(), message: z.string() }),
          alert: z.object({ level: z.string() }),
          payload: serializationPayloadSchema,
        }),
      },
    },
  },
})

/** keepAlive GET stream that replays history after the client's `Last-Event-ID`. */
export const replayableStreamContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Replayable stream',
  pathResolver: () => '/api/replayable/stream',
  responsesByStatusCode: {
    200: { content: { 'text/event-stream': sseBody({ update: z.object({ seq: z.number() }) }) } },
  },
})

/** Events already sent on the replayable stream, in id order. */
export const replayHistory = [1, 2, 3].map((seq) => ({
  id: String(seq),
  event: 'update' as const,
  data: { seq },
}))

/** POST stream answering one `chunk` per word of the message. */
export const chatCompletionContract = defineApiContract({
  visibility: 'public',
  method: 'post',
  summary: 'Chat completion stream',
  pathResolver: () => '/api/chat/completions',
  requestBodySchema: z.object({ message: z.string(), stream: z.literal(true) }),
  responsesByStatusCode: {
    200: {
      content: {
        'text/event-stream': sseBody({
          chunk: z.object({ content: z.string() }),
          done: z.object({ totalTokens: z.number() }),
        }),
      },
    },
  },
})

/**
 * POST stream whose handler opens the stream and then waits on a gate the test
 * releases. `failBeforeStart` makes it answer with the declared 503 instead.
 */
export const slowStartContract = defineApiContract({
  visibility: 'public',
  method: 'post',
  summary: 'Slow start stream',
  pathResolver: () => '/api/slow-start/stream',
  requestBodySchema: z.object({ prompt: z.string(), failBeforeStart: z.boolean().optional() }),
  responsesByStatusCode: {
    200: {
      content: {
        'text/event-stream': sseBody({
          chunk: z.object({ content: z.string() }),
          done: z.object({ totalTokens: z.number() }),
        }),
      },
    },
    503: z.object({ message: z.string() }),
  },
})

/** POST stream producing `chunkCount` events of `chunkSize` characters each. */
export const largeContentContract = defineApiContract({
  visibility: 'public',
  method: 'post',
  summary: 'Large content stream',
  pathResolver: () => '/api/large-content/stream',
  requestBodySchema: z.object({ chunkCount: z.number(), chunkSize: z.number() }),
  responsesByStatusCode: {
    200: {
      content: {
        'text/event-stream': sseBody({
          chunk: z.object({ index: z.number(), content: z.string() }),
          done: z.object({ totalChunks: z.number(), totalBytes: z.number() }),
        }),
      },
    },
  },
})

export type HttpE2eRouteDependencies = {
  spy: CreateSSESessionSpyResult
  slowWorkGate: HandlerGate
}

export function registerHttpE2eRoutes(
  app: FastifyInstance,
  { spy, slowWorkGate }: HttpE2eRouteDependencies,
): void {
  // Lets a URLSearchParams body reach the handler as an object, so a test can
  // tell it was sent form-encoded rather than JSON-stringified into {}
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, parseQueryString(body as string))
    },
  )

  // Non-SSE route without a response body
  app.post('/api/no-content', (_request, reply) => reply.code(204).send())

  app.route(
    buildApiRoute(
      notificationsStreamContract,
      (request, _reply, { sse }) => {
        sse.start('keepAlive', { context: { userId: request.query.userId } })
      },
      spy.routeOptions,
    ),
  )

  app.route(
    buildApiRoute(
      replayableStreamContract,
      (_request, _reply, { sse }) => {
        sse.start('keepAlive')
      },
      spy.withSpy<ApiRouteOptions<typeof replayableStreamContract>>({
        onReconnect: (_session, lastEventId) =>
          replayHistory.filter((message) => Number(message.id) > Number(lastEventId)),
      }),
    ),
  )

  app.route(
    buildApiRoute(chatCompletionContract, async (request, _reply, { sse }) => {
      const session = sse.start('autoClose')
      const words = request.body.message.split(' ')
      for (const word of words) {
        await session.send('chunk', { content: word })
      }
      await session.send('done', { totalTokens: words.length })
    }),
  )

  app.route(
    buildApiRoute(
      slowStartContract,
      async (request, _reply, { sse }) => {
        if (request.body.failBeforeStart) {
          return { status: 503, body: { message: 'Upstream unavailable' } }
        }
        const session = sse.start('autoClose')
        await slowWorkGate.wait()
        await session.send('chunk', { content: request.body.prompt })
        await session.send('done', { totalTokens: 1 })
        return
      },
      spy.routeOptions,
    ),
  )

  app.route(
    buildApiRoute(largeContentContract, async (request, _reply, { sse }) => {
      const { chunkCount, chunkSize } = request.body
      const session = sse.start('autoClose')
      for (let index = 0; index < chunkCount; index++) {
        const marker = `[chunk-${index}]`
        await session.send('chunk', { index, content: marker.padEnd(chunkSize, 'x') })
      }
      await session.send('done', { totalChunks: chunkCount, totalBytes: chunkCount * chunkSize })
    }),
  )
}
