import { defineApiContract, sseBody, sseResponse } from '@lokalise/api-contracts'
import { z } from 'zod/v4'

export const apiSseKeepAliveContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Api sse keep alive',
  pathResolver: () => '/api/test/sse-keep-alive',
  responsesByStatusCode: {
    200: { content: { 'text/event-stream': sseBody({ tick: z.object({ n: z.number() }) }) } },
  },
})

export const apiSseSendStreamContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Api sse send stream',
  pathResolver: () => '/api/test/sse-stream',
  responsesByStatusCode: {
    200: { content: { 'text/event-stream': sseBody({ item: z.object({ i: z.number() }) }) } },
  },
})

export const apiSseOnConnectContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Api sse on connect',
  pathResolver: () => '/api/test/sse-on-connect',
  responsesByStatusCode: {
    200: { content: { 'text/event-stream': sseBody({ ping: z.object({ seq: z.number() }) }) } },
  },
})

export const apiSseRespondContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Api sse respond',
  pathResolver: () => '/api/error-test/sse-respond',
  responsesByStatusCode: {
    200: { content: { 'text/event-stream': sseBody({ update: z.object({ value: z.number() }) }) } },
    404: z.object({ error: z.string() }),
  },
})

export const apiSseNoStartContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Api sse no start',
  pathResolver: () => '/api/error-test/sse-no-start',
  responsesByStatusCode: {
    200: { content: { 'text/event-stream': sseBody({ update: z.object({ value: z.number() }) }) } },
  },
})

export const apiSsePreErrorContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Api sse pre error',
  pathResolver: () => '/api/error-test/sse-pre-error',
  responsesByStatusCode: {
    200: { content: { 'text/event-stream': sseBody({ update: z.object({ value: z.number() }) }) } },
  },
})

export const apiSsePostErrorContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Api sse post error',
  pathResolver: () => '/api/error-test/sse-post-error',
  responsesByStatusCode: {
    200: { content: { 'text/event-stream': sseBody({ update: z.object({ value: z.number() }) }) } },
  },
})

export const apiSseInvalidEventContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Api sse invalid event',
  pathResolver: () => '/api/error-test/sse-invalid-event',
  responsesByStatusCode: {
    200: { content: { 'text/event-stream': sseBody({ typed: z.object({ value: z.number() }) }) } },
  },
})

export const apiValidationFailContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Api validation fail',
  pathResolver: () => '/api/error-test/validation-fail',
  responsesByStatusCode: { 200: z.object({ value: z.string() }) },
})

export const apiHeaderSuccessContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Api header success',
  pathResolver: () => '/api/error-test/header-ok',
  responsesByStatusCode: { 200: z.object({ ok: z.boolean() }) },
  responseHeaderSchema: z.object({ 'x-api-version': z.string() }),
})

export const apiHeaderFailContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Api header fail',
  pathResolver: () => '/api/error-test/header-fail',
  responsesByStatusCode: { 200: z.object({ ok: z.boolean() }) },
  responseHeaderSchema: z.object({ 'x-required-header': z.string() }),
})

export const roomStreamEventSchemas = {
  message: z.object({ from: z.string(), text: z.string() }),
  userJoined: z.object({ userId: z.string() }),
}

export const userSchema = z.object({ id: z.string(), name: z.string() })

export const apiGetUserContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Api get user',
  pathResolver: ({ userId }) => `/api/users/${userId}`,
  requestPathParamsSchema: z.object({ userId: z.string() }),
  responsesByStatusCode: { 200: userSchema },
})

export const apiCreateUserContract = defineApiContract({
  visibility: 'public',
  method: 'post',
  summary: 'Api create user',
  pathResolver: () => '/api/users',
  requestBodySchema: z.object({ name: z.string() }),
  responsesByStatusCode: { 201: userSchema },
})

export const feedEventSchemas = {
  update: z.object({ value: z.number() }),
}

export const apiFeedContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Api feed',
  pathResolver: () => '/api/feed',
  requestQuerySchema: z.object({ limit: z.coerce.number().int().optional() }),
  responsesByStatusCode: {
    200: {
      content: {
        'application/json': userSchema,
        'text/event-stream': sseBody(feedEventSchemas),
      },
    },
  },
})

// ============================================================================
// injectApiSSE fixtures
// ============================================================================

export const lqaEventSchemas = {
  review: z.object({ score: z.number() }),
  done: z.object({ total: z.number() }),
}

/** POST + body, an SSE 200 and a documented pre-stream error status. */
export const apiLqaSegmentContract = defineApiContract({
  visibility: 'internal',
  method: 'post',
  summary: 'Perform LQA on a text segment',
  pathResolver: () => '/api/inject-sse/lqa-text-segment',
  requestBodySchema: z.object({ segment: z.string() }),
  responsesByStatusCode: {
    200: sseResponse(lqaEventSchemas),
    400: z.object({ message: z.string() }),
  },
})

/** GET + path params, query params and a required header. */
export const apiTickStreamContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Stream ticks for a channel',
  pathResolver: ({ channelId }) => `/api/inject-sse/channels/${channelId}/ticks`,
  requestPathParamsSchema: z.object({ channelId: z.string() }),
  requestQuerySchema: z.object({ count: z.coerce.number().int() }),
  requestHeaderSchema: z.object({ authorization: z.string() }),
  responsesByStatusCode: {
    200: sseResponse({ tick: z.object({ channelId: z.string(), n: z.number() }) }),
    401: z.object({ message: z.string() }),
  },
})

// ============================================================================
// Progressive delivery / connectApiSSE fixtures
// ============================================================================

export const lqaIssueEventSchemas = {
  issue: z.object({ severity: z.enum(['neutral', 'minor', 'major', 'critical']) }),
  review: z.object({ score: z.number() }),
}

/**
 * The shape from the downstream reports: one `issue` event per quality issue found, as soon
 * as it exists, then a terminal `review`. Its point is *when* each event reaches the client,
 * so the handlers built on it are driven by a gate the test releases.
 */
export const apiLqaIssueStreamContract = defineApiContract({
  visibility: 'internal',
  method: 'post',
  summary: 'Stream LQA issues as they are found',
  pathResolver: () => '/api/sse-stream/lqa-issues',
  requestBodySchema: z.object({ segment: z.string() }),
  responsesByStatusCode: {
    200: sseResponse(lqaIssueEventSchemas),
    400: z.object({ message: z.string() }),
  },
})

/** GET + path params and a required header, streaming on a session that outlives the handler. */
export const apiChannelFeedContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Subscribe to a channel feed',
  pathResolver: ({ channelId }) => `/api/sse-stream/channels/${channelId}/feed`,
  requestPathParamsSchema: z.object({ channelId: z.string() }),
  requestQuerySchema: z.object({ since: z.coerce.number().int().optional() }),
  requestHeaderSchema: z.object({ authorization: z.string() }),
  responsesByStatusCode: {
    200: sseResponse({ ping: z.object({ channelId: z.string(), seq: z.number() }) }),
    401: z.object({ message: z.string() }),
  },
})
