import { describe, expect, it } from 'vitest'
import { type OpenApiDocumentLike, pruneUnreachableComponents } from './componentReachability.ts'

/**
 * Shaped like what `jsonSchemaTransformObject` produces: the whole Zod
 * registry in `components.schemas`, whether or not an operation survived to
 * reference it.
 */
function registryDocument(): OpenApiDocumentLike {
  return {
    openapi: '3.1.0',
    paths: {
      '/api/users/{userId}': {
        get: {
          responses: {
            200: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        User: { type: 'object', properties: { team: { $ref: '#/components/schemas/Team' } } },
        Team: { type: 'object' },
        UserInput: { type: 'object' },
        ReindexReport: { type: 'object', properties: { reindexedDocuments: { type: 'number' } } },
      },
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    },
  }
}

describe('pruneUnreachableComponents', () => {
  it('keeps components the surviving operations reference, transitively', () => {
    const result = pruneUnreachableComponents(registryDocument())

    expect(Object.keys(result.components?.schemas ?? {}).sort()).toEqual(['Team', 'User'])
  })

  it('drops registry schemas no operation references', () => {
    const result = pruneUnreachableComponents(registryDocument())

    expect(JSON.stringify(result)).not.toContain('reindexedDocuments')
    expect(result.components?.schemas).not.toHaveProperty('UserInput')
  })

  it('never prunes security schemes, which are referenced by name', () => {
    const result = pruneUnreachableComponents(registryDocument())

    expect(result.components?.securitySchemes).toEqual({
      bearer: { type: 'http', scheme: 'bearer' },
    })
  })

  it('does not mutate the source document', () => {
    const source = registryDocument()

    pruneUnreachableComponents(source)

    expect(source).toEqual(registryDocument())
  })

  it('is a no-op on a document with no components', () => {
    expect(pruneUnreachableComponents({ openapi: '3.1.0' })).toEqual({ openapi: '3.1.0' })
  })

  it('is idempotent', () => {
    const once = pruneUnreachableComponents(registryDocument())

    expect(pruneUnreachableComponents(once)).toEqual(once)
  })
})
