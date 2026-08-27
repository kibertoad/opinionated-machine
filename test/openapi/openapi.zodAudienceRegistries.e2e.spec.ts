import fastifySwagger from '@fastify/swagger'
import { defineApiContract } from '@lokalise/api-contracts'
import fastify, { type FastifyInstance } from 'fastify'
import {
  createJsonSchemaTransform,
  createJsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import { buildApiRoute, openApiVisibilityTransform } from '../../index.js'
import type { TestOpenApiDocument } from './testOpenApiDocument.ts'

/**
 * Per-audience Zod registries: the second way to get each document its own
 * model set.
 *
 * `pruneUnreachableComponents` derives the model set from what the surviving
 * operations reference, which is exact and needs no bookkeeping — but it
 * cannot keep a model that no operation references. When a document
 * deliberately publishes a catalogue beyond its operations, give each audience
 * its own registry instead: `createJsonSchemaTransform` and
 * `createJsonSchemaTransformObject` both take one.
 */

const userSchema = z.object({ id: z.string() })
const auditSchema = z.object({ at: z.string() })
const reportSchema = z.object({ reindexedDocuments: z.number() })
/** Published deliberately in both documents; no operation references it. */
const catalogueSchema = z.object({ contractVersion: z.string() })
/** Published deliberately in the internal document only. */
const internalCatalogueSchema = z.object({ secretKnob: z.string() })

const publicRegistry = z.registry<{ id?: string }>()
publicRegistry.add(userSchema, { id: 'User' })
publicRegistry.add(auditSchema, { id: 'Audit' })
publicRegistry.add(catalogueSchema, { id: 'Catalogue' })

const internalRegistry = z.registry<{ id?: string }>()
internalRegistry.add(userSchema, { id: 'User' })
internalRegistry.add(auditSchema, { id: 'Audit' })
internalRegistry.add(catalogueSchema, { id: 'Catalogue' })
internalRegistry.add(reportSchema, { id: 'Report' })
internalRegistry.add(internalCatalogueSchema, { id: 'InternalCatalogue' })

const getUserContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Get user',
  pathResolver: () => '/api/users',
  responsesByStatusCode: { 200: z.object({ user: userSchema, audit: auditSchema }) },
})

const reindexContract = defineApiContract({
  visibility: 'internal',
  method: 'post',
  summary: 'Reindex the search cluster',
  pathResolver: () => '/api/ops/reindex',
  requestBodySchema: z.object({ full: z.boolean() }),
  responsesByStatusCode: { 200: reportSchema },
})

function models(document: TestOpenApiDocument): string[] {
  return Object.keys(document.components?.schemas ?? {}).sort()
}

async function buildApp(): Promise<FastifyInstance> {
  const app = fastify()
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  await app.register(fastifySwagger, {
    openapi: { info: { title: 'Users API', version: '1.0.0' } },
    transform: openApiVisibilityTransform({
      audience: 'public',
      transform: createJsonSchemaTransform({ schemaRegistry: publicRegistry }),
    }),
    transformObject: createJsonSchemaTransformObject({ schemaRegistry: publicRegistry }),
  })
  await app.register(fastifySwagger, {
    decorator: 'internalSwagger',
    openapi: { info: { title: 'Users API (internal)', version: '1.0.0' } },
    transform: openApiVisibilityTransform({
      audience: 'internal',
      transform: createJsonSchemaTransform({ schemaRegistry: internalRegistry }),
    }),
    transformObject: createJsonSchemaTransformObject({ schemaRegistry: internalRegistry }),
  })

  app.route(
    buildApiRoute(getUserContract, async () => ({
      status: 200,
      body: { user: { id: 'u1' }, audit: { at: 'now' } },
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

describe('per-audience Zod registries', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
  })

  it('gives the public document only its own audience’s models', () => {
    expect(models(app.swagger() as TestOpenApiDocument)).toEqual([
      'Audit',
      'AuditInput',
      'Catalogue',
      'CatalogueInput',
      'User',
      'UserInput',
    ])
  })

  it('keeps internal models out of the public document entirely', () => {
    const publicDocument = JSON.stringify(app.swagger())

    expect(publicDocument).not.toContain('reindexedDocuments')
    expect(publicDocument).not.toContain('secretKnob')
    expect(publicDocument).not.toContain('Report')
  })

  it('publishes catalogue models no operation references', () => {
    // The case reachability pruning cannot serve: kept here, per audience.
    expect(models(app.swagger() as TestOpenApiDocument)).toContain('Catalogue')
    expect(JSON.stringify(app.swagger())).toContain('contractVersion')
  })

  it('gives the internal document its own catalogue on top', () => {
    const internalModels = models(app.internalSwagger())

    expect(internalModels).toContain('Report')
    expect(internalModels).toContain('InternalCatalogue')
    expect(internalModels).toContain('Catalogue')
  })

  it('still resolves shared models through $ref rather than inlining them', () => {
    expect(JSON.stringify(app.swagger())).toContain('#/components/schemas/User')
  })

  it('leaves no dangling model reference in either document', () => {
    for (const document of [app.swagger() as TestOpenApiDocument, app.internalSwagger()]) {
      const referenced = new Set(
        (JSON.stringify(document).match(/#\/components\/schemas\/[A-Za-z0-9_]+/g) ?? []).map(
          (ref) => ref.split('/').pop() as string,
        ),
      )
      const present = new Set(Object.keys(document.components?.schemas ?? {}))

      expect([...referenced].filter((name) => !present.has(name))).toEqual([])
    }
  })
})
