import { anyOfResponses, defineApiContract, sseResponse } from '@lokalise/api-contracts'
import { z } from 'zod/v4'

export const apiSseKeepAliveContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/api/test/sse-keep-alive',
  responsesByStatusCode: { 200: sseResponse({ tick: z.object({ n: z.number() }) }) },
})

export const apiSseSendStreamContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/api/test/sse-stream',
  responsesByStatusCode: { 200: sseResponse({ item: z.object({ i: z.number() }) }) },
})

export const apiSseRespondAfterStartContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/api/test/sse-respond-after-start',
  responsesByStatusCode: { 200: sseResponse({ msg: z.object({ text: z.string() }) }) },
})

export const apiSseSendHeadersContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/api/test/sse-send-headers',
  responsesByStatusCode: { 200: sseResponse({ done: z.object({ ok: z.boolean() }) }) },
})

export const apiSseInvalidEventContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/api/test/sse-invalid-event',
  responsesByStatusCode: { 200: sseResponse({ typed: z.object({ value: z.number() }) }) },
})

export const apiSseOnConnectContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/api/test/sse-on-connect',
  responsesByStatusCode: { 200: sseResponse({ ping: z.object({ seq: z.number() }) }) },
})

export const apiSseRespondContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/api/error-test/sse-respond',
  responsesByStatusCode: { 200: sseResponse({ update: z.object({ value: z.number() }) }) },
})

export const apiSseNoStartContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/api/error-test/sse-no-start',
  responsesByStatusCode: { 200: sseResponse({ update: z.object({ value: z.number() }) }) },
})

export const apiSsePreErrorContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/api/error-test/sse-pre-error',
  responsesByStatusCode: { 200: sseResponse({ update: z.object({ value: z.number() }) }) },
})

export const apiSsePostErrorContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/api/error-test/sse-post-error',
  responsesByStatusCode: { 200: sseResponse({ update: z.object({ value: z.number() }) }) },
})

export const apiValidationFailContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/api/error-test/validation-fail',
  responsesByStatusCode: { 200: z.object({ value: z.string() }) },
})

export const apiHeaderSuccessContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/api/error-test/header-ok',
  responsesByStatusCode: { 200: z.object({ ok: z.boolean() }) },
  responseHeaderSchema: z.object({ 'x-api-version': z.string() }),
})

export const apiHeaderFailContract = defineApiContract({
  method: 'get',
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
  method: 'get',
  pathResolver: ({ userId }) => `/api/users/${userId}`,
  requestPathParamsSchema: z.object({ userId: z.string() }),
  responsesByStatusCode: { 200: userSchema },
})

export const apiCreateUserContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/api/users',
  requestBodySchema: z.object({ name: z.string() }),
  responsesByStatusCode: { 201: userSchema },
})

export const feedEventSchemas = {
  update: z.object({ value: z.number() }),
}

export const apiFeedContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/api/feed',
  requestQuerySchema: z.object({ limit: z.coerce.number().int().optional() }),
  responsesByStatusCode: {
    200: anyOfResponses([userSchema, sseResponse(feedEventSchemas)]),
  },
})
