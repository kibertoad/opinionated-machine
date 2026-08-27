import fastifySwagger from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'
import { defineApiContract } from '@lokalise/api-contracts'
import scalarApiReference from '@scalar/fastify-api-reference'
import fastify, { type FastifyInstance } from 'fastify'
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import { buildApiRoute, openApiVisibilityTransform } from '../../index.js'
import type { TestOpenApiDocument } from './testOpenApiDocument.ts'

/**
 * Executable version of the "Serving Both Documents" README section.
 *
 * This package deliberately ships no documentation-serving plugin: both
 * `@fastify/swagger-ui` and `@scalar/fastify-api-reference` can already point
 * at a second document, and re-implementing that is how a project ends up
 * maintaining a worse copy of them. What this test pins down is that the two
 * recipes the README gives actually work against the real packages, including
 * the encapsulation gotcha below.
 */

const getUserContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Get user',
  pathResolver: ({ userId }) => `/api/users/${userId}`,
  requestPathParamsSchema: z.object({ userId: z.string() }),
  responsesByStatusCode: { 200: z.object({ id: z.string(), name: z.string() }) },
})

const reindexContract = defineApiContract({
  visibility: 'internal',
  method: 'post',
  summary: 'Reindex the search cluster',
  pathResolver: () => '/api/ops/reindex',
  requestBodySchema: z.object({ full: z.boolean() }),
  responsesByStatusCode: { 200: z.object({ reindexedDocuments: z.number() }) },
})

const DOCUMENTATION_PREFIXES = ['/documentation', '/reference']

/**
 * Both UIs register their own asset routes with `schema: { hide: true }`,
 * which `treatHiddenAsInternal` would otherwise read as "internal endpoint"
 * and surface in the internal document.
 */
const excludeDocumentationRoutes = ({ url }: { url: string }): boolean =>
  DOCUMENTATION_PREFIXES.some((prefix) => url.startsWith(prefix))

async function buildApp(): Promise<FastifyInstance> {
  const app = fastify()
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  await app.register(fastifySwagger, {
    openapi: { info: { title: 'Users API', version: '1.0.0' } },
    transform: openApiVisibilityTransform({
      audience: 'public',
      exclude: excludeDocumentationRoutes,
      transform: jsonSchemaTransform,
    }),
  })
  await app.register(fastifySwagger, {
    decorator: 'internalSwagger',
    openapi: { info: { title: 'Users API (internal)', version: '1.0.0' } },
    transform: openApiVisibilityTransform({
      audience: 'internal',
      exclude: excludeDocumentationRoutes,
      transform: jsonSchemaTransform,
    }),
  })

  // @fastify/swagger-ui decorates the instance it is registered on with
  // `swaggerCSP`, so a second top-level registration throws
  // FST_ERR_DEC_ALREADY_PRESENT. Wrapping each registration in its own
  // encapsulated scope gives each one its own decorator.
  await app.register(async (scope) => {
    await scope.register(fastifySwaggerUi, { routePrefix: '/documentation' })
  })
  await app.register(async (scope) => {
    await scope.register(fastifySwaggerUi, {
      routePrefix: '/documentation/internal',
      // swagger-ui always reads the default `swagger` decorator; this is the
      // supported way to serve a different document from it.
      transformSpecification: () => scope.internalSwagger(),
      transformSpecificationClone: false,
    })
  })

  // Scalar takes the document as configuration, so it needs no scope of its own.
  await app.register(scalarApiReference, { routePrefix: '/reference' })
  await app.register(scalarApiReference, {
    routePrefix: '/reference/internal',
    configuration: { content: () => app.internalSwagger() },
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

async function fetchDocument(app: FastifyInstance, url: string): Promise<TestOpenApiDocument> {
  const response = await app.inject({ method: 'GET', url })

  expect(response.statusCode).toBe(200)
  return JSON.parse(response.body) as TestOpenApiDocument
}

describe('serving both documents through existing documentation UIs', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
  })

  describe('@fastify/swagger-ui', () => {
    it('serves the public document at the default prefix', async () => {
      const document = await fetchDocument(app, '/documentation/json')

      expect(document.info?.title).toBe('Users API')
      expect(document.paths).toHaveProperty('/api/users/{userId}')
      expect(document.paths).not.toHaveProperty('/api/ops/reindex')
    })

    it('serves the internal document from the second registration', async () => {
      const document = await fetchDocument(app, '/documentation/internal/json')

      expect(document.info?.title).toBe('Users API (internal)')
      expect(document.paths).toHaveProperty('/api/ops/reindex')
    })

    it('renders both UIs', async () => {
      for (const url of ['/documentation/', '/documentation/internal/']) {
        const response = await app.inject({ method: 'GET', url })

        expect(response.statusCode).toBe(200)
        expect(response.headers['content-type']).toContain('text/html')
      }
    })
  })

  describe('@scalar/fastify-api-reference', () => {
    it('serves the public document at the default prefix', async () => {
      const document = await fetchDocument(app, '/reference/openapi.json')

      expect(document.info?.title).toBe('Users API')
      expect(document.paths).not.toHaveProperty('/api/ops/reindex')
    })

    it('serves the internal document from the second registration', async () => {
      const document = await fetchDocument(app, '/reference/internal/openapi.json')

      expect(document.info?.title).toBe('Users API (internal)')
      expect(document.paths).toHaveProperty('/api/ops/reindex')
    })

    it('renders both references', async () => {
      // Scalar redirects the bare prefix to the trailing-slash route.
      for (const url of ['/reference/', '/reference/internal/']) {
        const response = await app.inject({ method: 'GET', url })

        expect(response.statusCode).toBe(200)
        expect(response.headers['content-type']).toContain('text/html')
      }
    })
  })

  it('keeps the documentation routes out of both documents', () => {
    for (const document of [app.swagger() as TestOpenApiDocument, app.internalSwagger()]) {
      const paths = Object.keys(document.paths ?? {})

      expect(paths.filter((path) => path.startsWith('/documentation'))).toEqual([])
      expect(paths.filter((path) => path.startsWith('/reference'))).toEqual([])
    }
  })

  it('does not let the internal UI leak into the public document', async () => {
    const publicDocument = await fetchDocument(app, '/documentation/json')

    expect(JSON.stringify(publicDocument)).not.toContain('reindexedDocuments')
  })
})
