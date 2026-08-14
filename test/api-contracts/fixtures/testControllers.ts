import { AbstractApiController, buildApiRoute } from '../../../lib/api-contracts/index.ts'
import {
  apiCreateUserContract,
  apiFeedContract,
  apiGetUserContract,
  apiHeaderFailContract,
  apiHeaderSuccessContract,
  apiSseKeepAliveContract,
  apiSseNoStartContract,
  apiSsePreErrorContract,
  apiSseRespondContract,
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
