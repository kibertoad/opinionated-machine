import { z } from 'zod'
import { buildPayloadSSERoute, buildSSERoute } from '../../../index.js'

/**
 * Simple GET SSE route for integration tests
 */
export const streamContract = buildSSERoute({
  path: '/api/stream',
  params: z.object({}),
  query: z.object({ userId: z.string().optional() }),
  requestHeaders: z.object({}),
  events: { message: z.object({ text: z.string() }) },
})

/**
 * GET SSE route for notifications stream
 */
export const notificationsStreamContract = buildSSERoute({
  path: '/api/notifications/stream',
  params: z.object({}),
  query: z.object({
    userId: z.string().optional(),
  }),
  requestHeaders: z.object({}),
  events: {
    notification: z.object({
      id: z.string(),
      message: z.string(),
    }),
  },
})

/**
 * POST SSE route for chat completions (OpenAI-style)
 */
export const chatCompletionContract = buildPayloadSSERoute({
  method: 'POST',
  path: '/api/chat/completions',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  body: z.object({
    message: z.string(),
    stream: z.literal(true),
  }),
  events: {
    chunk: z.object({
      content: z.string(),
    }),
    done: z.object({
      totalTokens: z.number(),
    }),
  },
})

/**
 * GET SSE route with authentication header
 */
export const authenticatedStreamContract = buildSSERoute({
  path: '/api/protected/stream',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({
    authorization: z.string(),
  }),
  events: {
    data: z.object({
      value: z.string(),
    }),
  },
})

/**
 * GET SSE route with path params
 */
export const channelStreamContract = buildSSERoute({
  path: '/api/channels/:channelId/stream',
  params: z.object({
    channelId: z.string(),
  }),
  query: z.object({
    since: z.string().optional(),
  }),
  requestHeaders: z.object({}),
  events: {
    message: z.object({
      id: z.string(),
      content: z.string(),
      author: z.string(),
    }),
  },
})
