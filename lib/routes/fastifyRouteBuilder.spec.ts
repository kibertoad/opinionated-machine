import { buildSseContract } from '@lokalise/api-contracts'
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
  method: 'get',
  pathResolver: (pathParams) => `/api/test/${pathParams.testGetParam}`,
  requestPathParamsSchema: z.object({ testGetParam: z.string() }),
  requestQuerySchema: z.object({ testGetQuery: z.string() }),
  requestHeaderSchema: z.object({ testGetHeader: z.string() }),
  serverSentEventSchemas: { messageGet: z.object({ text: z.string() }) },
  metadata: { requiresAuth: true, rateLimit: 100 },
})

const ssePostContract = buildSseContract({
  method: 'post',
  pathResolver: (pathParams) => `/api/test/${pathParams.testPostParam}`,
  requestPathParamsSchema: z.object({ testPostParam: z.string() }),
  requestQuerySchema: z.object({ testPostQuery: z.string() }),
  requestHeaderSchema: z.object({ testPostHeader: z.string() }),
  requestBodySchema: z.object({ testPostBody: z.string() }),
  serverSentEventSchemas: { messagePost: z.object({ text: z.string() }) },
  metadata: { requiresAuth: true, rateLimit: 100 },
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
  method: 'get',
  pathResolver: (pathParams) => `/api/dual/${pathParams.dualGetParam}`,
  requestPathParamsSchema: z.object({ dualGetParam: z.string() }),
  requestQuerySchema: z.object({ dualGetQuery: z.string() }),
  requestHeaderSchema: z.object({ dualGetHeader: z.string() }),
  successResponseBodySchema: z.object({ result: z.string() }),
  serverSentEventSchemas: { messageDualGet: z.object({ text: z.string() }) },
  metadata: { requiresAuth: true, rateLimit: 100 },
})

const dualModePostContract = buildSseContract({
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
