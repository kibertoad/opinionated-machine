import fastifySwagger from '@fastify/swagger'
import { defineApiContract } from '@lokalise/api-contracts'
import fastify, { type FastifyInstance } from 'fastify'
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import { buildApiRoute, openApiVisibilityTransform, stripInternalOperations } from '../../index.js'
import type { TestOpenApiDocument } from './testOpenApiDocument.ts'

const userSchema = z.object({ id: z.string(), name: z.string() })
const reindexReportSchema = z.object({ reindexedDocuments: z.number() })

const getUserContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Get user',
  tags: ['users'],
  pathResolver: ({ userId }) => `/api/users/${userId}`,
  requestPathParamsSchema: z.object({ userId: z.string() }),
  responsesByStatusCode: { 200: userSchema },
})

const reindexContract = defineApiContract({
  visibility: 'internal',
  method: 'post',
  summary: 'Reindex the search cluster',
  tags: ['ops'],
  pathResolver: () => '/api/ops/reindex',
  requestBodySchema: z.object({ full: z.boolean() }),
  responsesByStatusCode: { 200: reindexReportSchema },
})

async function buildApp(): Promise<FastifyInstance> {
  const app = fastify()
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  // Customer-facing document -> app.swagger()
  await app.register(fastifySwagger, {
    openapi: { info: { title: 'Users API', version: '1.0.0' } },
    transform: openApiVisibilityTransform({ audience: 'public', transform: jsonSchemaTransform }),
  })

  // Internal document -> app.internalSwagger()
  await app.register(fastifySwagger, {
    decorator: 'internalSwagger',
    openapi: { info: { title: 'Users API (internal)', version: '1.0.0' } },
    transform: openApiVisibilityTransform({ audience: 'internal', transform: jsonSchemaTransform }),
  })

  app.route(
    buildApiRoute(getUserContract, async (request) => ({
      status: 200,
      body: { id: request.params.userId, name: 'Alice' },
    })),
  )
  app.route(
    buildApiRoute(reindexContract, async () => ({
      status: 200,
      body: { reindexedDocuments: 12 },
    })),
  )

  // Not built from a contract: no visibility marker, documented in both.
  app.route({
    method: 'GET',
    url: '/health',
    schema: { summary: 'Health check' },
    handler: async () => ({ status: 'ok' }),
  })

  // Hidden without a contract: the internal document surfaces it, because in
  // this ecosystem `hide` means "not for the public spec".
  app.route({
    method: 'GET',
    url: '/metrics',
    schema: { summary: 'Prometheus metrics', hide: true },
    handler: async () => 'metrics',
  })

  // Tagged X-HIDDEN: @fastify/swagger's audience-independent escape hatch.
  app.route({
    method: 'GET',
    url: '/debug/heap',
    schema: { summary: 'Heap dump', tags: ['X-HIDDEN'] },
    handler: async () => ({}),
  })

  await app.ready()
  return app
}

describe('OpenAPI documents per audience', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await buildApp()
  })

  afterEach(async () => {
    await app.close()
  })

  describe('public document', () => {
    it('documents public contract routes', () => {
      const document = app.swagger() as TestOpenApiDocument

      expect(document.paths?.['/api/users/{userId}']?.get?.summary).toBe('Get user')
    })

    it('omits internal contract routes', () => {
      const document = app.swagger() as TestOpenApiDocument

      expect(document.paths?.['/api/ops/reindex']).toBeUndefined()
    })

    it('keeps routes that carry no visibility marker', () => {
      const document = app.swagger() as TestOpenApiDocument

      expect(document.paths?.['/health']?.get).toBeDefined()
    })

    it('leaves explicitly hidden routes hidden', () => {
      const document = app.swagger() as TestOpenApiDocument

      expect(document.paths?.['/metrics']).toBeUndefined()
      expect(document.paths?.['/debug/heap']).toBeUndefined()
    })

    it('does not leak schemas only internal routes use', () => {
      const document = app.swagger() as TestOpenApiDocument

      expect(JSON.stringify(document)).not.toContain('reindexedDocuments')
    })

    it('does not leak the visibility marker', () => {
      const document = app.swagger() as TestOpenApiDocument

      expect(JSON.stringify(document)).not.toContain('visibility')
    })
  })

  describe('internal document', () => {
    it('documents internal contract routes, fully resolved', () => {
      const document = app.internalSwagger()

      const operation = document.paths?.['/api/ops/reindex']?.post
      expect(operation?.summary).toBe('Reindex the search cluster')
      expect(JSON.stringify(operation)).toContain('reindexedDocuments')
    })

    it('marks internal operations', () => {
      const document = app.internalSwagger()

      expect(document.paths?.['/api/ops/reindex']?.post?.['x-internal']).toBe(true)
      expect(document.paths?.['/api/users/{userId}']?.get?.['x-internal']).toBeUndefined()
    })

    it('documents public routes too', () => {
      const document = app.internalSwagger()

      expect(document.paths?.['/api/users/{userId}']?.get?.summary).toBe('Get user')
    })

    it('surfaces routes hidden without a contract', () => {
      const document = app.internalSwagger()

      expect(document.paths?.['/metrics']?.get?.summary).toBe('Prometheus metrics')
    })

    it('still respects the X-HIDDEN escape hatch', () => {
      const document = app.internalSwagger()

      expect(document.paths?.['/debug/heap']).toBeUndefined()
    })
  })

  describe('both documents are generated from the same routes', () => {
    it('does not let one audience corrupt the other', () => {
      // Generate in the opposite order to prove the transforms do not mutate
      // the shared route schemas.
      const internalFirst = JSON.stringify(app.internalSwagger())
      const publicDocument = JSON.stringify(app.swagger())

      expect(internalFirst).toContain('/api/ops/reindex')
      expect(publicDocument).not.toContain('/api/ops/reindex')
    })
  })

  describe('deriving the public document from the internal one', () => {
    it('produces the same operation set as a dedicated public registration', () => {
      const derived = stripInternalOperations(app.internalSwagger())
      const generated = app.swagger() as TestOpenApiDocument

      // /metrics is hidden by `hide: true` rather than by a contract, so it is
      // only in the internal document via `treatHiddenAsInternal` — the marker
      // is what the derived document filters on, and it carries one.
      expect(Object.keys(derived.paths ?? {}).sort()).toEqual(
        Object.keys(generated.paths ?? {}).sort(),
      )
    })

    it('drops schemas only internal operations referenced', () => {
      const derived = stripInternalOperations(app.internalSwagger())

      expect(JSON.stringify(derived)).not.toContain('reindexedDocuments')
    })

    it('leaves the internal document intact', () => {
      const before = JSON.stringify(app.internalSwagger())

      stripInternalOperations(app.internalSwagger())

      expect(JSON.stringify(app.internalSwagger())).toBe(before)
    })
  })
})
