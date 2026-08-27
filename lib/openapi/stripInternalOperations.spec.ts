import { describe, expect, it } from 'vitest'
import { type OpenApiDocumentLike, stripInternalOperations } from './stripInternalOperations.ts'

function internalDocument(): OpenApiDocumentLike {
  return {
    openapi: '3.1.0',
    info: { title: 'Users API', version: '1.0.0' },
    tags: [{ name: 'users' }, { name: 'ops', description: 'internal tooling' }],
    paths: {
      '/users/{userId}': {
        get: { tags: ['users'], responses: { 200: { $ref: '#/components/schemas/User' } } },
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
      },
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    },
  }
}

describe('stripInternalOperations', () => {
  it('removes operations marked as internal', () => {
    const result = stripInternalOperations(internalDocument())

    expect(result.paths?.['/users/{userId}']).toEqual({
      get: { tags: ['users'], responses: { 200: { $ref: '#/components/schemas/User' } } },
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

      expect(Object.keys(result.components?.schemas ?? {})).toEqual(['User', 'Team'])
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
      ])
      expect(result.tags).toHaveLength(2)
    })
  })

  it('handles documents without paths or components', () => {
    expect(stripInternalOperations({ openapi: '3.1.0' })).toEqual({ openapi: '3.1.0' })
  })
})
