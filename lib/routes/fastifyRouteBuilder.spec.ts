import { buildSseContract } from '@lokalise/api-contracts'
import type { RouteOptions } from 'fastify'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { z } from 'zod/v4'
import {
  AbstractDualModeController,
  AbstractSSEController,
  type BuildFastifyDualModeRoutesReturnType,
  type BuildFastifySSERoutesReturnType,
  type DualModeRouteHandler,
  type SSERouteHandler,
  type SyncModeReply,
} from '../../index.js'
import { buildFastifyRoute } from './fastifyRouteBuilder.ts'
import { buildHandler } from './fastifyRouteTypes.ts'

// ============================================================================
// Minimal fixtures
// ============================================================================

const sseGetContract = buildSseContract({
  visibility: 'public',
  method: 'get',
  pathResolver: (pathParams) => `/api/test/${pathParams.testGetParam}`,
  requestPathParamsSchema: z.object({ testGetParam: z.string() }),
  requestQuerySchema: z.object({ testGetQuery: z.string() }),
  requestHeaderSchema: z.object({ testGetHeader: z.string() }),
  serverSentEventSchemas: { messageGet: z.object({ text: z.string() }) },
  metadata: { requiresAuth: true, rateLimit: 100 },
  summary: 'SSE get route',
  description: 'Streams test messages',
  tags: ['sse-test'],
})

const ssePostContract = buildSseContract({
  visibility: 'public',
  method: 'post',
  pathResolver: (pathParams) => `/api/test/${pathParams.testPostParam}`,
  requestPathParamsSchema: z.object({ testPostParam: z.string() }),
  requestQuerySchema: z.object({ testPostQuery: z.string() }),
  requestHeaderSchema: z.object({ testPostHeader: z.string() }),
  requestBodySchema: z.object({ testPostBody: z.string() }),
  serverSentEventSchemas: { messagePost: z.object({ text: z.string() }) },
  metadata: { requiresAuth: true, rateLimit: 100 },
})

const sseErrorsContract = buildSseContract({
  visibility: 'public',
  method: 'get',
  pathResolver: () => '/api/errors',
  requestPathParamsSchema: z.object({}),
  responseBodySchemasByStatusCode: {
    404: z.object({ error: z.string() }),
    422: z.object({ details: z.string() }),
  },
  serverSentEventSchemas: { messageGet: z.object({ text: z.string() }) },
})

class MinimalSSEController extends AbstractSSEController<any> {
  private readonly handler: SSERouteHandler<any>

  constructor(handler: SSERouteHandler<any>) {
    super({})
    this.handler = handler
  }
  buildSSERoutes(): BuildFastifySSERoutesReturnType<any> {
    return { test: this.handler }
  }
}

const dualModeGetContract = buildSseContract({
  visibility: 'public',
  method: 'get',
  pathResolver: (pathParams) => `/api/dual/${pathParams.dualGetParam}`,
  requestPathParamsSchema: z.object({ dualGetParam: z.string() }),
  requestQuerySchema: z.object({ dualGetQuery: z.string() }),
  requestHeaderSchema: z.object({ dualGetHeader: z.string() }),
  successResponseBodySchema: z.object({ result: z.string() }),
  serverSentEventSchemas: { messageDualGet: z.object({ text: z.string() }) },
  metadata: { requiresAuth: true, rateLimit: 100 },
  summary: 'Dual-mode get route',
  description: 'Returns or streams the result',
  tags: ['dual-mode-test'],
})

const dualModePostContract = buildSseContract({
  visibility: 'public',
  method: 'post',
  pathResolver: (pathParams) => `/api/dual/${pathParams.dualPostParam}`,
  requestPathParamsSchema: z.object({ dualPostParam: z.string() }),
  requestQuerySchema: z.object({ dualPostQuery: z.string() }),
  requestHeaderSchema: z.object({ dualPostHeader: z.string() }),
  requestBodySchema: z.object({ dualPostBody: z.string() }),
  successResponseBodySchema: z.object({ result: z.string() }),
  serverSentEventSchemas: { messageDualPost: z.object({ text: z.string() }) },
  metadata: { requiresAuth: true, rateLimit: 100 },
})

class MinimalDualModeController extends AbstractDualModeController<any> {
  private readonly handler: DualModeRouteHandler<any>

  constructor(handler: DualModeRouteHandler<any>) {
    super({})
    this.handler = handler
  }
  buildDualModeRoutes(): BuildFastifyDualModeRoutesReturnType<any> {
    return { test: this.handler }
  }
}

function getResponseSchemas(routeOptions: RouteOptions): Record<string, unknown> {
  return (routeOptions.schema as { response: Record<string, unknown> }).response
}

function getContentSchema(
  routeOptions: RouteOptions,
  statusCode: number,
  mediaType: string,
): z.ZodTypeAny {
  const entry = getResponseSchemas(routeOptions)[statusCode] as {
    content: Record<string, { schema: z.ZodTypeAny }>
  }
  const schema = entry.content[mediaType]?.schema
  if (!schema) {
    throw new Error(`No response schema for ${statusCode} ${mediaType}`)
  }
  return schema
}

// ============================================================================
// Tests
// ============================================================================

describe('buildFastifyRoute', () => {
  describe('SSE', () => {
    it('should build get route options', () => {
      const handler = buildHandler(sseGetContract, {
        sse: async (_req, _sse) => await Promise.resolve(),
      })

      const routeOptions = buildFastifyRoute(new MinimalSSEController(handler), handler)

      expect(routeOptions).toMatchObject({
        handler: expect.any(Function),
        method: 'get',
        schema: {
          params: sseGetContract.requestPathParamsSchema,
          querystring: sseGetContract.requestQuerySchema,
          headers: sseGetContract.requestHeaderSchema,
          description: 'Streams test messages',
          summary: 'SSE get route',
          tags: ['sse-test'],
        },
        sse: true,
        url: '/api/test/:testGetParam',
      })
    })

    it('should build post route options', () => {
      const handler = buildHandler(ssePostContract, {
        sse: async (_req, _sse) => await Promise.resolve(),
      })

      const routeOptions = buildFastifyRoute(new MinimalSSEController(handler), handler)

      expect(routeOptions).toMatchObject({
        handler: expect.any(Function),
        method: 'post',
        schema: {
          params: ssePostContract.requestPathParamsSchema,
          querystring: ssePostContract.requestQuerySchema,
          headers: ssePostContract.requestHeaderSchema,
          body: ssePostContract.requestBodySchema,
        },
        sse: true,
        url: '/api/test/:testPostParam',
      })
    })

    it('should set sse config with serializer when serializer is provided', () => {
      const serializer = (data: unknown) => JSON.stringify(data)
      const handler = buildHandler(
        sseGetContract,
        { sse: async (_req, _sse) => await Promise.resolve() },
        { serializer },
      )

      const routeOptions = buildFastifyRoute(new MinimalSSEController(handler), handler)

      expect(routeOptions.sse).toEqual({ serializer })
    })

    it('should set sse config with heartbeatInterval when heartbeatInterval is provided', () => {
      const handler = buildHandler(
        sseGetContract,
        { sse: async (_req, _sse) => await Promise.resolve() },
        { heartbeatInterval: 5000 },
      )

      const routeOptions = buildFastifyRoute(new MinimalSSEController(handler), handler)

      expect(routeOptions.sse).toEqual({ heartbeatInterval: 5000 })
    })

    it('should hide route from OpenAPI docs when contract visibility is internal', () => {
      const internalContract = buildSseContract({
        method: 'get',
        pathResolver: (pathParams) => `/api/test/${pathParams.testGetParam}`,
        requestPathParamsSchema: z.object({ testGetParam: z.string() }),
        serverSentEventSchemas: { messageGet: z.object({ text: z.string() }) },
        visibility: 'internal',
      })
      const handler = buildHandler(internalContract, {
        sse: async (_req, _sse) => await Promise.resolve(),
      })

      const routeOptions = buildFastifyRoute(new MinimalSSEController(handler), handler)

      expect(routeOptions.schema).toMatchObject({ hide: true })
    })

    it('should not hide route from OpenAPI docs when contract visibility is public', () => {
      const publicContract = buildSseContract({
        method: 'get',
        pathResolver: (pathParams) => `/api/test/${pathParams.testGetParam}`,
        requestPathParamsSchema: z.object({ testGetParam: z.string() }),
        serverSentEventSchemas: { messageGet: z.object({ text: z.string() }) },
        visibility: 'public',
      })
      const handler = buildHandler(publicContract, {
        sse: async (_req, _sse) => await Promise.resolve(),
      })

      const routeOptions = buildFastifyRoute(new MinimalSSEController(handler), handler)

      expect(routeOptions.schema).toMatchObject({ hide: false })
    })

    it('fails closed: hides routes whose contract lacks visibility at runtime', () => {
      const legacyContract = buildSseContract({
        method: 'get',
        pathResolver: (pathParams) => `/api/test/${pathParams.testGetParam}`,
        requestPathParamsSchema: z.object({ testGetParam: z.string() }),
        serverSentEventSchemas: { messageGet: z.object({ text: z.string() }) },
        visibility: 'public',
      })
      delete (legacyContract as { visibility?: unknown }).visibility
      const handler = buildHandler(legacyContract, {
        sse: async (_req, _sse) => await Promise.resolve(),
      })

      const routeOptions = buildFastifyRoute(new MinimalSSEController(handler), handler)

      expect(routeOptions.schema).toMatchObject({ hide: true })
    })

    describe('response schema', () => {
      it('documents the event stream under 200 text/event-stream', () => {
        const handler = buildHandler(sseGetContract, {
          sse: async (_req, _sse) => await Promise.resolve(),
        })

        const routeOptions = buildFastifyRoute(new MinimalSSEController(handler), handler)

        const eventSchema = getContentSchema(routeOptions, 200, 'text/event-stream')
        expect(eventSchema.parse({ event: 'messageGet', data: { text: 'hi' } })).toEqual({
          event: 'messageGet',
          data: { text: 'hi' },
        })
      })

      it('documents error statuses declared by the contract', () => {
        const handler = buildHandler(sseErrorsContract, {
          sse: async (_req, _sse) => await Promise.resolve(),
        })

        const routeOptions = buildFastifyRoute(new MinimalSSEController(handler), handler)

        const response = getResponseSchemas(routeOptions)
        expect(response[404]).toBe(sseErrorsContract.responseBodySchemasByStatusCode?.[404])
        expect(response[422]).toBe(sseErrorsContract.responseBodySchemasByStatusCode?.[422])
      })
    })

    describe('contractMetadataToRouteMapper', () => {
      it('should use contract metadata mapper', () => {
        const onRequestHook = vi.fn()
        const handler = buildHandler(
          sseGetContract,
          { sse: async (_req, _sse) => await Promise.resolve() },
          {
            contractMetadataToRouteMapper: (meta) => ({
              config: { isAuthenticated: meta?.requiresAuth, limit: meta?.rateLimit },
              onRequest: onRequestHook,
            }),
          },
        )

        const routeOptions = buildFastifyRoute(new MinimalSSEController(handler), handler)

        expect(routeOptions.config).toEqual({ isAuthenticated: true, limit: 100 })
        expect(routeOptions.onRequest).toBe(onRequestHook)
      })

      it('handles mapper returning empty object without errors', () => {
        const handler = buildHandler(
          sseGetContract,
          { sse: async (_req, _sse) => await Promise.resolve() },
          { contractMetadataToRouteMapper: () => ({}) },
        )

        const routeOptions = buildFastifyRoute(new MinimalSSEController(handler), handler)

        expect(routeOptions).toBeDefined()
      })
    })
  })

  describe('dual-mode', () => {
    it('should build get route options', () => {
      const handler = buildHandler(dualModeGetContract, {
        sync: async (_req, _reply) => await Promise.resolve({ result: 'ok' }),
        sse: async (_req, _sse) => await Promise.resolve(),
      })

      const routeOptions = buildFastifyRoute(new MinimalDualModeController(handler), handler)

      expect(routeOptions).toMatchObject({
        handler: expect.any(Function),
        method: 'get',
        schema: {
          params: dualModeGetContract.requestPathParamsSchema,
          querystring: dualModeGetContract.requestQuerySchema,
          headers: dualModeGetContract.requestHeaderSchema,
          description: 'Returns or streams the result',
          summary: 'Dual-mode get route',
          tags: ['dual-mode-test'],
        },
        sse: true,
        url: '/api/dual/:dualGetParam',
      })
    })

    it('should build post route options', () => {
      const handler = buildHandler(dualModePostContract, {
        sync: async (_req, _reply) => await Promise.resolve({ result: 'ok' }),
        sse: async (_req, _sse) => await Promise.resolve(),
      })

      const routeOptions = buildFastifyRoute(new MinimalDualModeController(handler), handler)

      expect(routeOptions).toMatchObject({
        handler: expect.any(Function),
        method: 'post',
        schema: {
          params: dualModePostContract.requestPathParamsSchema,
          querystring: dualModePostContract.requestQuerySchema,
          headers: dualModePostContract.requestHeaderSchema,
          body: dualModePostContract.requestBodySchema,
        },
        sse: true,
        url: '/api/dual/:dualPostParam',
      })
    })

    it('should set sse config with serializer when serializer is provided', () => {
      const serializer = (data: unknown) => JSON.stringify(data)
      const handler = buildHandler(
        dualModeGetContract,
        {
          sync: async (_req, _reply) => await Promise.resolve({ result: 'ok' }),
          sse: async (_req, _sse) => await Promise.resolve(),
        },
        { serializer },
      )

      const routeOptions = buildFastifyRoute(new MinimalDualModeController(handler), handler)

      expect(routeOptions.sse).toEqual({ serializer })
    })

    it('should set sse config with heartbeatInterval when heartbeatInterval is provided', () => {
      const handler = buildHandler(
        dualModeGetContract,
        {
          sync: async (_req, _reply) => await Promise.resolve({ result: 'ok' }),
          sse: async (_req, _sse) => await Promise.resolve(),
        },
        { heartbeatInterval: 5000 },
      )

      const routeOptions = buildFastifyRoute(new MinimalDualModeController(handler), handler)

      expect(routeOptions.sse).toEqual({ heartbeatInterval: 5000 })
    })

    it('should hide route from OpenAPI docs when contract visibility is internal', () => {
      const internalContract = buildSseContract({
        method: 'get',
        pathResolver: (pathParams) => `/api/dual/${pathParams.dualGetParam}`,
        requestPathParamsSchema: z.object({ dualGetParam: z.string() }),
        successResponseBodySchema: z.object({ result: z.string() }),
        serverSentEventSchemas: { messageDualGet: z.object({ text: z.string() }) },
        visibility: 'internal',
      })
      const handler = buildHandler(internalContract, {
        sync: async (_req, _reply) => await Promise.resolve({ result: 'ok' }),
        sse: async (_req, _sse) => await Promise.resolve(),
      })

      const routeOptions = buildFastifyRoute(new MinimalDualModeController(handler), handler)

      expect(routeOptions.schema).toMatchObject({ hide: true })
    })

    it('should not hide route from OpenAPI docs when contract visibility is public', () => {
      const publicContract = buildSseContract({
        method: 'get',
        pathResolver: (pathParams) => `/api/dual/${pathParams.dualGetParam}`,
        requestPathParamsSchema: z.object({ dualGetParam: z.string() }),
        successResponseBodySchema: z.object({ result: z.string() }),
        serverSentEventSchemas: { messageDualGet: z.object({ text: z.string() }) },
        visibility: 'public',
      })
      const handler = buildHandler(publicContract, {
        sync: async (_req, _reply) => await Promise.resolve({ result: 'ok' }),
        sse: async (_req, _sse) => await Promise.resolve(),
      })

      const routeOptions = buildFastifyRoute(new MinimalDualModeController(handler), handler)

      expect(routeOptions.schema).toMatchObject({ hide: false })
    })

    it('fails closed: hides routes whose contract lacks visibility at runtime', () => {
      const legacyContract = buildSseContract({
        method: 'get',
        pathResolver: (pathParams) => `/api/dual/${pathParams.dualGetParam}`,
        requestPathParamsSchema: z.object({ dualGetParam: z.string() }),
        successResponseBodySchema: z.object({ result: z.string() }),
        serverSentEventSchemas: { messageDualGet: z.object({ text: z.string() }) },
        visibility: 'public',
      })
      delete (legacyContract as { visibility?: unknown }).visibility
      const handler = buildHandler(legacyContract, {
        sync: async (_req, _reply) => await Promise.resolve({ result: 'ok' }),
        sse: async (_req, _sse) => await Promise.resolve(),
      })

      const routeOptions = buildFastifyRoute(new MinimalDualModeController(handler), handler)

      expect(routeOptions.schema).toMatchObject({ hide: true })
    })

    describe('response schema', () => {
      it('documents both the sync body and the event stream under 200', () => {
        const handler = buildHandler(dualModeGetContract, {
          sync: async (_req, _reply) => await Promise.resolve({ result: 'ok' }),
          sse: async (_req, _sse) => await Promise.resolve(),
        })

        const routeOptions = buildFastifyRoute(new MinimalDualModeController(handler), handler)

        expect(getContentSchema(routeOptions, 200, 'application/json')).toBe(
          dualModeGetContract.successResponseBodySchema,
        )
        const eventSchema = getContentSchema(routeOptions, 200, 'text/event-stream')
        expect(eventSchema.parse({ event: 'messageDualGet', data: { text: 'hi' } })).toEqual({
          event: 'messageDualGet',
          data: { text: 'hi' },
        })
      })
    })

    describe('contractMetadataToRouteMapper', () => {
      it('should use contract metadata mapper', () => {
        const onRequestHook = vi.fn()
        const handler = buildHandler(
          dualModeGetContract,
          {
            sync: async (_req, _reply) => await Promise.resolve({ result: 'ok' }),
            sse: async (_req, _sse) => await Promise.resolve(),
          },
          {
            contractMetadataToRouteMapper: (meta) => ({
              config: { isAuthenticated: meta?.requiresAuth, limit: meta?.rateLimit },
              onRequest: onRequestHook,
            }),
          },
        )

        const routeOptions = buildFastifyRoute(new MinimalDualModeController(handler), handler)

        expect(routeOptions.config).toEqual({ isAuthenticated: true, limit: 100 })
        expect(routeOptions.onRequest).toBe(onRequestHook)
      })

      it('handles mapper returning empty object without errors', () => {
        const handler = buildHandler(
          dualModeGetContract,
          {
            sync: async (_req, _reply) => await Promise.resolve({ result: 'ok' }),
            sse: async (_req, _sse) => await Promise.resolve(),
          },
          { contractMetadataToRouteMapper: () => ({}) },
        )

        const routeOptions = buildFastifyRoute(new MinimalDualModeController(handler), handler)

        expect(routeOptions).toBeDefined()
      })
    })

    it('should not have send() on SyncModeReply', () => {
      expectTypeOf<SyncModeReply>().not.toHaveProperty('send')
    })

    it('should return SyncModeReply from fluent setters', () => {
      expectTypeOf<SyncModeReply['code']>().returns.toEqualTypeOf<SyncModeReply>()
      expectTypeOf<SyncModeReply['status']>().returns.toEqualTypeOf<SyncModeReply>()
      expectTypeOf<SyncModeReply['header']>().returns.toEqualTypeOf<SyncModeReply>()
      expectTypeOf<SyncModeReply['headers']>().returns.toEqualTypeOf<SyncModeReply>()
      expectTypeOf<SyncModeReply['removeHeader']>().returns.toEqualTypeOf<SyncModeReply>()
      expectTypeOf<SyncModeReply['type']>().returns.toEqualTypeOf<SyncModeReply>()
      expectTypeOf<SyncModeReply['serializer']>().returns.toEqualTypeOf<SyncModeReply>()
      expectTypeOf<SyncModeReply['hijack']>().returns.toEqualTypeOf<SyncModeReply>()
      expectTypeOf<SyncModeReply['removeTrailer']>().returns.toEqualTypeOf<SyncModeReply>()
    })

    it('should preserve non-fluent FastifyReply properties', () => {
      expectTypeOf<SyncModeReply>().toHaveProperty('statusCode')
      expectTypeOf<SyncModeReply>().toHaveProperty('raw')
      expectTypeOf<SyncModeReply>().toHaveProperty('elapsedTime')
      expectTypeOf<SyncModeReply>().toHaveProperty('getHeader')
      expectTypeOf<SyncModeReply>().toHaveProperty('hasHeader')
    })

    it('should reject reply.send() via chained fluent setters at compile time', () => {
      buildHandler(dualModeGetContract, {
        sync: (_req, reply) => {
          // @ts-expect-error - send() should not exist after code()
          reply.code(200).send({ result: 'ok' })
          // @ts-expect-error - send() should not exist after status()
          reply.status(200).send({ result: 'ok' })
          // @ts-expect-error - send() should not exist after header()
          reply.header('x-test', 'value').send({ result: 'ok' })
          // @ts-expect-error - send() should not exist after type()
          reply.type('application/json').send({ result: 'ok' })
          // @ts-expect-error - send() should not exist after multi-chain
          reply.code(201).header('x-test', 'value').type('application/json').send({ result: 'ok' })
          return { result: 'ok' }
        },
        sse: async (_req, _sse) => await Promise.resolve(),
      })
    })
  })
})
