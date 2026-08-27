import { describe, expect, it } from 'vitest'
import { type OpenApiDocumentLike, stripInternalOperations } from './stripInternalOperations.ts'

/** Every `$ref` in `document` that no longer resolves to anything. */
function danglingRefs(document: unknown): string[] {
  const refs: string[] = []
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (typeof value !== 'object' || value === null) return
    for (const [key, nested] of Object.entries(value)) {
      if (key === '$ref' && typeof nested === 'string') refs.push(nested)
      else walk(nested)
    }
  }
  walk(document)

  return refs.filter((candidate) => {
    const segments = candidate.replace(/^#\//, '').split('/')
    let cursor: unknown = document
    for (const segment of segments) {
      if (typeof cursor !== 'object' || cursor === null) return true
      cursor = (cursor as Record<string, unknown>)[segment]
    }
    return cursor === undefined
  })
}

function internalDocument(): OpenApiDocumentLike {
  return {
    openapi: '3.1.0',
    info: { title: 'Users API', version: '1.0.0' },
    tags: [{ name: 'users' }, { name: 'ops', description: 'internal tooling' }],
    paths: {
      '/users/{userId}': {
        get: {
          tags: ['users'],
          responses: {
            200: { $ref: '#/components/schemas/User' },
            404: { $ref: '#/components/responses/NotFound' },
          },
        },
        delete: { tags: ['ops'], 'x-internal': true, responses: { 204: {} } },
      },
      '/ops/reindex': {
        post: {
          tags: ['ops'],
          'x-internal': true,
          responses: { 200: { $ref: '#/components/schemas/ReindexReport' } },
        },
      },
    },
    components: {
      schemas: {
        User: { type: 'object', properties: { team: { $ref: '#/components/schemas/Team' } } },
        Team: { type: 'object' },
        ReindexReport: { type: 'object' },
        // Reachable only through the shared `NotFound` response below.
        Problem: { type: 'object', properties: { detail: { type: 'string' } } },
      },
      responses: {
        NotFound: {
          description: 'Not found',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/Problem' } },
          },
        },
      },
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    },
  }
}

describe('stripInternalOperations', () => {
  it('removes operations marked as internal', () => {
    const result = stripInternalOperations(internalDocument())

    expect(result.paths?.['/users/{userId}']).toEqual({
      get: {
        tags: ['users'],
        responses: {
          200: { $ref: '#/components/schemas/User' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    })
  })

  it('removes path items left without operations', () => {
    const result = stripInternalOperations(internalDocument())

    expect(Object.keys(result.paths ?? {})).toEqual(['/users/{userId}'])
  })

  it('keeps path items that still have a public operation', () => {
    const result = stripInternalOperations(internalDocument())

    expect(result.paths?.['/users/{userId}']).toBeDefined()
  })

  it('does not mutate the source document', () => {
    const source = internalDocument()

    stripInternalOperations(source)

    expect(source).toEqual(internalDocument())
  })

  it('honours a custom marker key', () => {
    const document: OpenApiDocumentLike = {
      paths: { '/ops': { get: { 'x-audience-internal': true } } },
    }

    const result = stripInternalOperations(document, { markerKey: 'x-audience-internal' })

    expect(result.paths).toEqual({})
  })

  it('leaves operations whose marker is not exactly true', () => {
    const document: OpenApiDocumentLike = {
      paths: { '/ops': { get: { 'x-internal': 'internal' } } },
    }

    const result = stripInternalOperations(document)

    expect(result.paths?.['/ops']).toEqual({ get: { 'x-internal': 'internal' } })
  })

  describe('pruning', () => {
    it('drops component schemas only internal operations referenced', () => {
      const result = stripInternalOperations(internalDocument())

      expect(Object.keys(result.components?.schemas ?? {})).not.toContain('ReindexReport')
    })

    it('keeps schemas reachable only transitively', () => {
      const result = stripInternalOperations(internalDocument())

      expect(result.components?.schemas).toHaveProperty('Team')
    })

    it('leaves non-schema components alone', () => {
      const result = stripInternalOperations(internalDocument())

      expect(result.components?.securitySchemes).toEqual({
        bearer: { type: 'http', scheme: 'bearer' },
      })
    })

    it('drops tags no remaining operation uses', () => {
      const result = stripInternalOperations(internalDocument())

      expect(result.tags).toEqual([{ name: 'users' }])
    })

    it('removes an emptied schemas map entirely', () => {
      const document: OpenApiDocumentLike = {
        paths: { '/ops': { get: { 'x-internal': true } } },
        components: { schemas: { Report: { type: 'object' } } },
      }

      const result = stripInternalOperations(document)

      expect(result.components).toEqual({})
    })

    it('can be disabled', () => {
      const result = stripInternalOperations(internalDocument(), { prune: false })

      expect(Object.keys(result.components?.schemas ?? {})).toEqual([
        'User',
        'Team',
        'ReindexReport',
        'Problem',
      ])
      expect(result.tags).toHaveLength(2)
    })

    it('keeps schemas reachable only through a shared response component', () => {
      // `Problem` is referenced from `components.responses.NotFound`, which a
      // surviving operation still uses. Collecting roots from the paths alone
      // would drop `Problem` and leave that `$ref` dangling.
      const result = stripInternalOperations(internalDocument())

      expect(result.components?.responses).toHaveProperty('NotFound')
      expect(result.components?.schemas).toHaveProperty('Problem')
    })

    it('leaves no dangling $ref behind', () => {
      const result = stripInternalOperations(internalDocument())

      expect(danglingRefs(result)).toEqual([])
    })

    it('prunes non-schema component sections nothing references', () => {
      const document: OpenApiDocumentLike = {
        paths: {
          '/ops': {
            get: {
              'x-internal': true,
              responses: { 404: { $ref: '#/components/responses/NotFound' } },
            },
          },
        },
        components: {
          responses: { NotFound: { description: 'Not found' } },
          securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
        },
      }

      const result = stripInternalOperations(document)

      expect(result.components).toEqual({
        securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      })
    })

    it('keeps schemas a discriminator mapping points at', () => {
      const document: OpenApiDocumentLike = {
        paths: {
          '/pets': { get: { responses: { 200: { $ref: '#/components/schemas/Pet' } } } },
        },
        components: {
          schemas: {
            Pet: {
              oneOf: [{ $ref: '#/components/schemas/Cat' }],
              discriminator: {
                propertyName: 'kind',
                mapping: { cat: '#/components/schemas/Cat', dog: 'Dog' },
              },
            },
            Cat: { type: 'object' },
            Dog: { type: 'object' },
          },
        },
      }

      const result = stripInternalOperations(document)

      // `Dog` is named only by the mapping, in the shorthand form.
      expect(Object.keys(result.components?.schemas ?? {}).sort()).toEqual(['Cat', 'Dog', 'Pet'])
    })

    it('does not mistake a property named discriminator for a discriminator object', () => {
      const document: OpenApiDocumentLike = {
        paths: {
          '/things': { get: { responses: { 200: { $ref: '#/components/schemas/Thing' } } } },
        },
        components: {
          schemas: {
            Thing: { type: 'object', properties: { discriminator: { type: 'string' } } },
            Unused: { type: 'object' },
          },
        },
      }

      const result = stripInternalOperations(document)

      expect(Object.keys(result.components?.schemas ?? {})).toEqual(['Thing'])
    })
  })

  it('rejects a marker key @fastify/swagger could never have written', () => {
    expect(() => stripInternalOperations({}, { markerKey: 'internal' })).toThrow(
      /must be an OpenAPI extension key starting with "x-"/,
    )
  })

  it('handles documents without paths or components', () => {
    expect(stripInternalOperations({ openapi: '3.1.0' })).toEqual({ openapi: '3.1.0' })
  })
})
