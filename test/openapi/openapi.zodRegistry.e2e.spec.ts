import fastifySwagger from '@fastify/swagger'
import { defineApiContract } from '@lokalise/api-contracts'
import fastify, { type FastifyInstance } from 'fastify'
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import {
  buildApiRoute,
  openApiVisibilityTransform,
  pruneUnreachableComponents,
  stripInternalOperations,
} from '../../index.js'
import type { TestOpenApiDocument } from './testOpenApiDocument.ts'

/**
 * The audience transform and `fastify-type-provider-zod` together, with named
 * schemas going through `components` rather than being inlined.
 *
 * `jsonSchemaTransformObject` writes the *whole* Zod registry into
 * `components.schemas` in one pass over the finished document. It never sees
 * which operations the audience transform hid, so on its own it puts internal
 * request and response shapes into the customer-facing document even though no
 * public operation references them. `pruneUnreachableComponents` is what
 * brings the document back in line with its own operation set.
 */

// `.meta({ id })` registers the schema, which is what makes it a component.
const userSchema = z.object({ id: z.string(), name: z.string() }).meta({ id: 'User' })
const reindexReportSchema = z
  .object({ reindexedDocuments: z.number() })
  .meta({ id: 'ReindexReport' })

const getUserContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Get user',
  pathResolver: ({ userId }) => `/api/users/${userId}`,
  requestPathParamsSchema: z.object({ userId: z.string() }),
  responsesByStatusCode: { 200: userSchema },
})

const reindexContract = defineApiContract({
  visibility: 'internal',
  method: 'post',
  summary: 'Reindex the search cluster',
  pathResolver: () => '/api/ops/reindex',
  requestBodySchema: z.object({ full: z.boolean() }),
  responsesByStatusCode: { 200: reindexReportSchema },
})

/** The internal-only shape that must not reach the public document. */
const INTERNAL_ONLY_PROPERTY = 'reindexedDocuments'

async function buildApp(prune: boolean): Promise<FastifyInstance> {
  const app = fastify()
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  const transformObject = prune
    ? (input: Parameters<typeof jsonSchemaTransformObject>[0]) =>
        pruneUnreachableComponents(jsonSchemaTransformObject(input))
    : jsonSchemaTransformObject

  await app.register(fastifySwagger, {
    openapi: { info: { title: 'Users API', version: '1.0.0' } },
    transform: openApiVisibilityTransform({ audience: 'public', transform: jsonSchemaTransform }),
    transformObject,
  })
  await app.register(fastifySwagger, {
    decorator: 'internalSwagger',
    openapi: { info: { title: 'Users API (internal)', version: '1.0.0' } },
    transform: openApiVisibilityTransform({ audience: 'internal', transform: jsonSchemaTransform }),
    transformObject,
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

  await app.ready()
  return app
}

describe('audience documents with fastify-type-provider-zod', () => {
  describe('components without pruning', () => {
    let app: FastifyInstance

    beforeEach(async () => {
      app = await buildApp(false)
    })

    afterEach(async () => {
      await app.close()
    })

    it('still hides internal operations from the public document', () => {
      const document = app.swagger() as TestOpenApiDocument

      expect(document.paths).not.toHaveProperty('/api/ops/reindex')
    })

    it('but leaks internal schemas into it through the registry', () => {
      // Pinning the failure mode the prune step exists for: jsonSchemaTransformObject
      // emits every registered schema, whether or not an operation survived.
      const document = app.swagger() as TestOpenApiDocument

      expect(document.components?.schemas).toHaveProperty('ReindexReport')
      expect(JSON.stringify(document)).toContain(INTERNAL_ONLY_PROPERTY)
    })
  })

  describe('components with pruning', () => {
    let app: FastifyInstance

    beforeEach(async () => {
      app = await buildApp(true)
    })

    afterEach(async () => {
      await app.close()
    })

    it('keeps schemas the public operations reference', () => {
      const document = app.swagger() as TestOpenApiDocument

      expect(document.components?.schemas).toHaveProperty('User')
      expect(document.paths).toHaveProperty('/api/users/{userId}')
    })

    it('drops internal schemas from the public document', () => {
      const document = app.swagger() as TestOpenApiDocument

      expect(document.components?.schemas).not.toHaveProperty('ReindexReport')
      expect(JSON.stringify(document)).not.toContain(INTERNAL_ONLY_PROPERTY)
    })

    it('leaves the internal document its own schemas', () => {
      const document = app.internalSwagger()

      expect(document.paths).toHaveProperty('/api/ops/reindex')
      expect(document.components?.schemas).toHaveProperty('ReindexReport')
      expect(document.components?.schemas).toHaveProperty('User')
    })

    it('resolves operations through $ref rather than inlining them', () => {
      // Otherwise this whole suite would be testing nothing.
      const document = app.swagger() as TestOpenApiDocument

      expect(JSON.stringify(document.paths)).toContain('#/components/schemas/User')
    })

    it('leaves no dangling $ref in either document', () => {
      for (const document of [app.swagger() as TestOpenApiDocument, app.internalSwagger()]) {
        const refs = JSON.stringify(document).match(/"#\/components\/schemas\/[^"]+"/g) ?? []
        const names = new Set(Object.keys(document.components?.schemas ?? {}))

        for (const ref of refs) {
          expect(names).toContain(ref.slice('"#/components/schemas/'.length, -1))
        }
      }
    })
  })

  describe('deriving the public document instead', () => {
    let app: FastifyInstance

    beforeEach(async () => {
      // No prune step: stripInternalOperations does the pruning itself.
      app = await buildApp(false)
    })

    afterEach(async () => {
      await app.close()
    })

    it('drops internal operations and their registry schemas in one pass', () => {
      const derived = stripInternalOperations(app.internalSwagger())

      expect(derived.paths).not.toHaveProperty('/api/ops/reindex')
      expect(derived.components?.schemas).not.toHaveProperty('ReindexReport')
      expect(JSON.stringify(derived)).not.toContain(INTERNAL_ONLY_PROPERTY)
    })

    it('keeps what the public operations still reference', () => {
      const derived = stripInternalOperations(app.internalSwagger())

      expect(derived.components?.schemas).toHaveProperty('User')
    })
  })
})
