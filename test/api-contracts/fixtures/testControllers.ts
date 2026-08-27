import { AbstractApiController, buildApiRoute } from '../../../lib/api-contracts/index.ts'
import {
  apiCreateUserContract,
  apiFeedContract,
  apiGetUserContract,
  apiHeaderFailContract,
  apiHeaderSuccessContract,
  apiLqaSegmentContract,
  apiSseInvalidEventContract,
  apiSseKeepAliveContract,
  apiSseNoStartContract,
  apiSsePostErrorContract,
  apiSsePreErrorContract,
  apiSseRespondContract,
  apiSseSendStreamContract,
  apiTickStreamContract,
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

    feed: buildApiRoute(
      TestApiController.contracts.feed,
      async (request, _reply, { expectedContentType, sse }) => {
        if (expectedContentType === 'text/event-stream') {
          const session = sse.start('autoClose')
          await session.send('update', { value: 42 })
          return
        }
        return {
          status: 200,
          contentType: 'application/json',
          body: { id: 'summary', name: `limit=${request.query.limit ?? 'none'}` },
        }
      },
    ),

    sseKeepAlive: buildApiRoute(
      TestApiController.contracts.sseKeepAlive,
      async (_request, _reply, { sse }) => {
        const session = sse.start('keepAlive')
        await session.send('tick', { n: 1 })
      },
    ),

    // Declarative streaming: an SSE status body is an AsyncIterable of events.
    sseSendStream: buildApiRoute(TestApiController.contracts.sseSendStream, () => {
      // biome-ignore lint/suspicious/useAwait: async generator required for AsyncIterable
      async function* items() {
        yield { event: 'item' as const, data: { i: 1 } }
        yield { event: 'item' as const, data: { i: 2 } }
      }
      return { status: 200, body: items() }
    }),
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
    sseInvalidEvent: apiSseInvalidEventContract,
    validationFail: apiValidationFailContract,
    headerSuccess: apiHeaderSuccessContract,
    headerFail: apiHeaderFailContract,
  } as const

  readonly routes = {
    // Early HTTP response from an SSE-capable handler: return { status, body }
    // without calling sse.start().
    sseRespond: buildApiRoute(TestApiErrorController.contracts.sseRespond, () => ({
      status: 404,
      body: { error: 'not found' },
    })),

    sseNoStart: buildApiRoute(TestApiErrorController.contracts.sseNoStart, () => {
      // intentionally does nothing — exercises the invalid-handler-result error path
    }),

    ssePreError: buildApiRoute(TestApiErrorController.contracts.ssePreError, () => {
      throw Object.assign(new Error('pre-start error'), { statusCode: 422 })
    }),

    ssePostError: buildApiRoute(
      TestApiErrorController.contracts.ssePostError,
      async (_request, _reply, { sse }) => {
        const session = sse.start('autoClose')
        await session.send('update', { value: 1 })
        throw new Error('post-start error')
      },
    ),

    sseInvalidEvent: buildApiRoute(
      TestApiErrorController.contracts.sseInvalidEvent,
      async (_request, _reply, { sse }) => {
        const session = sse.start('autoClose')
        // Fails the `typed` event schema after the stream has started
        await session.send('typed', { value: 'not-a-number' as unknown as number })
      },
    ),

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
  }
}

/**
 * Controller backing the `injectApiSSE` tests: one POST-with-body SSE route and one
 * GET route with path params, query params and a required auth header. Both declare a
 * documented pre-stream error status, emitted via a plain `{ status, body }` result.
 */
export class TestApiInjectSSEController extends AbstractApiController<
  typeof TestApiInjectSSEController.contracts
> {
  static contracts = {
    lqaSegment: apiLqaSegmentContract,
    tickStream: apiTickStreamContract,
  } as const

  readonly routes = {
    lqaSegment: buildApiRoute(
      TestApiInjectSSEController.contracts.lqaSegment,
      async (request, _reply, { sse }) => {
        if (request.body.segment.length === 0) {
          return { status: 400, body: { message: 'segment must not be empty' } }
        }
        const session = sse.start('autoClose')
        await session.send('review', { score: request.body.segment.length })
        await session.send('done', { total: 1 })
        return
      },
    ),

    tickStream: buildApiRoute(
      TestApiInjectSSEController.contracts.tickStream,
      async (request, _reply, { sse }) => {
        if (request.headers.authorization !== 'Bearer valid-token') {
          return { status: 401, body: { message: 'Unauthorized' } }
        }
        const session = sse.start('autoClose')
        for (let n = 1; n <= request.query.count; n++) {
          await session.send('tick', { channelId: request.params.channelId, n })
        }
        return
      },
    ),
  }
}
