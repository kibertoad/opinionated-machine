import { AbstractApiController, buildApiRoute } from '../../../lib/api-contracts/index.ts'
import {
  apiCreateUserContract,
  apiFeedContract,
  apiGetUserContract,
  apiHeaderFailContract,
  apiHeaderSuccessContract,
  apiSseInvalidEventContract,
  apiSseKeepAliveContract,
  apiSseNoStartContract,
  apiSsePostErrorContract,
  apiSsePreErrorContract,
  apiSseRespondAfterStartContract,
  apiSseRespondContract,
  apiSseSendHeadersContract,
  apiSseSendStreamContract,
  apiValidationFailContract,
} from './testContracts.ts'

export class TestApiController extends AbstractApiController {
  readonly routes = [
    buildApiRoute(apiGetUserContract, async (request) => ({
      status: 200,
      body: { id: request.params.userId, name: 'Alice' },
    })),

    buildApiRoute(apiCreateUserContract, (request) => ({
      status: 201,
      body: { id: '1', name: request.body.name },
    })),

    buildApiRoute(apiFeedContract, {
      nonSse: async (request) => ({
        status: 200,
        body: { id: 'summary', name: `limit=${request.query.limit ?? 'none'}` },
      }),
      sse: async (_request, sse) => {
        const session = sse.start('autoClose')
        await session.send('update', { value: 42 })
      },
    }),

    buildApiRoute(apiSseKeepAliveContract, async (_request, sse) => {
      const session = sse.start('keepAlive')
      await session.send('tick', { n: 1 })
    }),

    buildApiRoute(apiSseSendStreamContract, async (_request, sse) => {
      const session = sse.start('autoClose')
      // biome-ignore lint/suspicious/useAwait: async generator required for AsyncIterable
      async function* items() {
        yield { event: 'item' as const, data: { i: 1 } }
        yield { event: 'item' as const, data: { i: 2 } }
      }
      await session.sendStream(items())
    }),
  ]
}

export class TestApiErrorController extends AbstractApiController {
  readonly routes = [
    buildApiRoute(apiSseRespondContract, (_request, sse) => {
      sse.respond(404, { error: 'not found' })
    }),

    buildApiRoute(apiSseNoStartContract, () => {
      // intentionally does nothing — exercises the no-start/no-respond error path
    }),

    buildApiRoute(apiSsePreErrorContract, () => {
      throw Object.assign(new Error('pre-start error'), { httpStatusCode: 422 })
    }),

    buildApiRoute(apiSsePostErrorContract, (_request, sse) => {
      sse.start('autoClose')
      throw new Error('post-start error')
    }),

    buildApiRoute(apiValidationFailContract, () => ({
      status: 200,
      body: { value: 123 as unknown as string },
    })),

    buildApiRoute(apiHeaderSuccessContract, (_request, reply) => {
      reply.header('x-api-version', '1.0')
      return { status: 200, body: { ok: true } }
    }),

    buildApiRoute(apiHeaderFailContract, () => ({
      status: 200,
      body: { ok: true },
    })),

    buildApiRoute(apiSseRespondAfterStartContract, (_request, sse) => {
      sse.start('autoClose')
      sse.respond(200, { text: 'too late' })
    }),

    buildApiRoute(apiSseSendHeadersContract, async (_request, sse) => {
      sse.sendHeaders()
      const session = sse.start('autoClose')
      await session.send('done', { ok: true })
    }),

    buildApiRoute(apiSseInvalidEventContract, async (_request, sse) => {
      const session = sse.start('autoClose')
      await session.send('typed', { value: 'not-a-number' as unknown as number })
    }),
  ]
}
