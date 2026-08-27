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
} from '../../index.js'
import type { TestOpenApiDocument } from './testOpenApiDocument.ts'

/**
 * What ends up in the "Models" / "Schemas" panel of a documentation UI.
 *
 * Both `@fastify/swagger-ui` and `@scalar/fastify-api-reference` render that
 * panel straight from `components.schemas`, so an internal model reaching it is
 * a leak a reader can see, not merely one in the JSON. This suite covers the
 * cases where "which models survive" is not obvious: the paired input/output
 * variants the Zod provider emits, self-referential models, a model shared
 * between audiences, and a registered model no operation references.
 *
 * The Zod registry is module-scoped, so these schemas stay in their own file.
 */

// Self-referential, via the Zod 4 getter pattern.
const categorySchema: z.ZodType = z
  .object({
    name: z.string(),
    get children() {
      return z.array(categorySchema)
    },
  })
  .meta({ id: 'Category' })

const addressSchema = z.object({ city: z.string() }).meta({ id: 'Address' })
const userSchema = z
  .object({ id: z.string(), address: addressSchema, category: categorySchema })
  .meta({ id: 'User' })
/** Referenced by a public operation and an internal one. */
const auditSchema = z.object({ at: z.string() }).meta({ id: 'Audit' })
/** Referenced only by the internal operation. */
const reportSchema = z
  .object({ reindexedDocuments: z.number(), audit: auditSchema })
  .meta({ id: 'Report' })
/** Registered and referenced by nothing at all. */
const orphanSchema = z.object({ unusedField: z.string() }).meta({ id: 'Orphan' })

const getUserContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Get user',
  pathResolver: ({ userId }) => `/api/users/${userId}`,
  requestPathParamsSchema: z.object({ userId: z.string() }),
  responsesByStatusCode: { 200: z.object({ user: userSchema, audit: auditSchema }) },
})

// Takes `User` as a body, which is what makes the `UserInput` variant live.
const createUserContract = defineApiContract({
  visibility: 'public',
  method: 'post',
  summary: 'Create user',
  pathResolver: () => '/api/users',
  requestBodySchema: userSchema,
  responsesByStatusCode: { 200: userSchema },
})

const reindexContract = defineApiContract({
  visibility: 'internal',
  method: 'post',
  summary: 'Reindex the search cluster',
  pathResolver: () => '/api/ops/reindex',
  requestBodySchema: z.object({ full: z.boolean() }),
  responsesByStatusCode: { 200: reportSchema },
})

// Referenced so the linter keeps the registration, which is the point of it.
void orphanSchema

function models(document: TestOpenApiDocument): string[] {
  return Object.keys(document.components?.schemas ?? {}).sort()
}

function danglingRefs(document: TestOpenApiDocument): string[] {
  const referenced = new Set(
    (JSON.stringify(document).match(/#\/components\/schemas\/[A-Za-z0-9_]+/g) ?? []).map(
      (ref) => ref.split('/').pop() as string,
    ),
  )
  const present = new Set(Object.keys(document.components?.schemas ?? {}))

  return [...referenced].filter((name) => !present.has(name)).sort()
}

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

  // The handlers only exist so the routes register; the documents are the subject.
  const category = { name: 'root', children: [] }
  const user = { id: 'u1', address: { city: 'Vilnius' }, category }
  app.route(
    buildApiRoute(getUserContract, async () => ({
      status: 200,
      body: { user, audit: { at: 'now' } },
    })),
  )
  app.route(buildApiRoute(createUserContract, async () => ({ status: 200, body: user })))
  app.route(
    buildApiRoute(reindexContract, async () => ({
      status: 200,
      body: { reindexedDocuments: 12, audit: { at: 'now' } },
    })),
  )

  await app.ready()
  return app
}

describe('the Models panel', () => {
  describe('without pruning', () => {
    let app: FastifyInstance

    beforeEach(async () => {
      app = await buildApp(false)
    })

    afterEach(async () => {
      await app.close()
    })

    it('lists the whole registry in both documents, internal models included', () => {
      const everything = models(app.internalSwagger())

      expect(models(app.swagger() as TestOpenApiDocument)).toEqual(everything)
      expect(everything).toContain('Report')
      expect(everything).toContain('Orphan')
    })
  })

  describe('with pruning', () => {
    let app: FastifyInstance

    beforeEach(async () => {
      app = await buildApp(true)
    })

    afterEach(async () => {
      await app.close()
    })

    it('drops models only an internal operation reaches', () => {
      const publicModels = models(app.swagger() as TestOpenApiDocument)

      expect(publicModels).not.toContain('Report')
      expect(JSON.stringify(app.swagger())).not.toContain('reindexedDocuments')
      expect(models(app.internalSwagger())).toContain('Report')
    })

    it('keeps a model shared between a public and an internal operation', () => {
      expect(models(app.swagger() as TestOpenApiDocument)).toContain('Audit')
      expect(models(app.internalSwagger())).toContain('Audit')
    })

    it('drops a registered model no operation references', () => {
      // The one case to skip pruning for: a deliberately published catalogue.
      expect(models(app.swagger() as TestOpenApiDocument)).not.toContain('Orphan')
      expect(models(app.internalSwagger())).not.toContain('Orphan')
    })

    it('keeps only the direction of each input/output pair that is used', () => {
      const publicModels = models(app.swagger() as TestOpenApiDocument)

      // `User` is a request body, so both variants are live, transitively.
      expect(publicModels).toEqual(
        expect.arrayContaining(['User', 'UserInput', 'Address', 'AddressInput']),
      )
      // `Audit` is only ever a response, so its input twin goes.
      expect(publicModels).toContain('Audit')
      expect(publicModels).not.toContain('AuditInput')
    })

    it('keeps a self-referential model, cycle and all', () => {
      const publicDocument = app.swagger() as TestOpenApiDocument

      expect(models(publicDocument)).toContain('Category')
      expect(JSON.stringify(publicDocument.components?.schemas?.Category)).toContain('Category')
    })

    it('leaves no dangling model reference in either document', () => {
      expect(danglingRefs(app.swagger() as TestOpenApiDocument)).toEqual([])
      expect(danglingRefs(app.internalSwagger())).toEqual([])
    })
  })
})
