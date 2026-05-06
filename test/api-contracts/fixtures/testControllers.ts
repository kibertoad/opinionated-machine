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

export class TestApiController extends AbstractApiController<typeof TestApiController.contracts> {
  static contracts = {
    getUser: apiGetUserContract,
    createUser: apiCreateUserContract,
    feed: apiFeedContract,
    sseKeepAlive: apiSseKeepAliveContract,
    sseSendStream: apiSseSendStreamContract,
  } as const

  readonly routes = {
    getUser: buildApiRoute(
      TestApiController.contracts.getUser,
      async (request) => ({
        status: 200,
        body: { id: request.params.userId, name: 'Alice' },
      }),
      { gatewayMetadata: { cache: { ttl: '60s' }, tags: ['users'] } },
    ),

    createUser: buildApiRoute(TestApiController.contracts.createUser, (request) => ({
      status: 201,
      body: { id: '1', name: request.body.name },
    })),

    feed: buildApiRoute(TestApiController.contracts.feed, {
      nonSse: async (request) => ({
        status: 200,
        body: { id: 'summary', name: `limit=${request.query.limit ?? 'none'}` },
      }),
      sse: async (_request, sse) => {
        const session = sse.start('autoClose')
        await session.send('update', { value: 42 })
      },
    }),

    sseKeepAlive: buildApiRoute(TestApiController.contracts.sseKeepAlive, async (_request, sse) => {
      const session = sse.start('keepAlive')
      await session.send('tick', { n: 1 })
    }),

    sseSendStream: buildApiRoute(
      TestApiController.contracts.sseSendStream,
      async (_request, sse) => {
        const session = sse.start('autoClose')
        // biome-ignore lint/suspicious/useAwait: async generator required for AsyncIterable
        async function* items() {
          yield { event: 'item' as const, data: { i: 1 } }
          yield { event: 'item' as const, data: { i: 2 } }
        }
        await session.sendStream(items())
      },
    ),
  }
}

export class TestApiErrorController extends AbstractApiController<
  typeof TestApiErrorController.contracts
> {
  static contracts = {
    sseRespond: apiSseRespondContract,
    sseNoStart: apiSseNoStartContract,
    ssePreError: apiSsePreErrorContract,
    ssePostError: apiSsePostErrorContract,
    validationFail: apiValidationFailContract,
    headerSuccess: apiHeaderSuccessContract,
    headerFail: apiHeaderFailContract,
    sseRespondAfterStart: apiSseRespondAfterStartContract,
    sseSendHeaders: apiSseSendHeadersContract,
    sseInvalidEvent: apiSseInvalidEventContract,
  } as const

  readonly routes = {
    sseRespond: buildApiRoute(TestApiErrorController.contracts.sseRespond, (_request, sse) => {
      sse.respond(404, { error: 'not found' })
    }),

    sseNoStart: buildApiRoute(TestApiErrorController.contracts.sseNoStart, () => {
      // intentionally does nothing — exercises the no-start/no-respond error path
    }),

    ssePreError: buildApiRoute(TestApiErrorController.contracts.ssePreError, () => {
      throw Object.assign(new Error('pre-start error'), { httpStatusCode: 422 })
    }),

    ssePostError: buildApiRoute(TestApiErrorController.contracts.ssePostError, (_request, sse) => {
      sse.start('autoClose')
      throw new Error('post-start error')
    }),

    validationFail: buildApiRoute(TestApiErrorController.contracts.validationFail, () => ({
      status: 200,
      body: { value: 123 as unknown as string },
    })),

    headerSuccess: buildApiRoute(
      TestApiErrorController.contracts.headerSuccess,
      (_request, reply) => {
        reply.header('x-api-version', '1.0')
        return { status: 200, body: { ok: true } }
      },
    ),

    headerFail: buildApiRoute(TestApiErrorController.contracts.headerFail, () => ({
      status: 200,
      body: { ok: true },
    })),

    sseRespondAfterStart: buildApiRoute(
      TestApiErrorController.contracts.sseRespondAfterStart,
      (_request, sse) => {
        sse.start('autoClose')
        sse.respond(200, { text: 'too late' })
      },
    ),

    sseSendHeaders: buildApiRoute(
      TestApiErrorController.contracts.sseSendHeaders,
      async (_request, sse) => {
        sse.sendHeaders()
        const session = sse.start('autoClose')
        await session.send('done', { ok: true })
      },
    ),

    sseInvalidEvent: buildApiRoute(
      TestApiErrorController.contracts.sseInvalidEvent,
      async (_request, sse) => {
        const session = sse.start('autoClose')
        await session.send('typed', { value: 'not-a-number' as unknown as number })
      },
    ),
  }
}
