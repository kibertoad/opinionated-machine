import { buildSseContract } from '@lokalise/api-contracts'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v4'
import {
  AbstractSSEController,
  type BuildFastifySSERoutesReturnType,
  type SSERouteHandler,
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
})
