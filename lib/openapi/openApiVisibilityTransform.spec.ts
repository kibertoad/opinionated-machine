import { describe, expect, it, vi } from 'vitest'
import { openApiVisibilityTransform } from './openApiVisibilityTransform.ts'
import type { OpenApiRouteSchema } from './visibility.ts'

function transformInput(schema: OpenApiRouteSchema | undefined, url = '/api/items') {
  return {
    schema: schema as OpenApiRouteSchema,
    url,
    route: { method: 'GET', url },
    openapiObject: { openapi: '3.1.0' },
  }
}

describe('openApiVisibilityTransform', () => {
  describe('public audience', () => {
    const transform = openApiVisibilityTransform({ audience: 'public' })

    it('keeps public routes visible', () => {
      const result = transform(transformInput({ hide: false, visibility: 'public' }))

      expect(result.schema).toEqual({ hide: false })
    })

    it('hides internal routes', () => {
      const result = transform(transformInput({ hide: true, visibility: 'internal' }))

      expect(result.schema).toEqual({ hide: true })
    })

    it('hides routes whose visibility is neither public nor internal', () => {
      const result = transform(transformInput({ hide: true, visibility: 'partner' }))

      expect(result.schema).toEqual({ hide: true })
    })

    it('honours a custom set of public visibilities', () => {
      const partnerAware = openApiVisibilityTransform({
        audience: 'public',
        publicVisibilities: ['public', 'partner'],
      })

      const result = partnerAware(transformInput({ hide: true, visibility: 'partner' }))

      expect(result.schema).toEqual({ hide: false })
    })
  })

  describe('internal audience', () => {
    const transform = openApiVisibilityTransform({ audience: 'internal' })

    it('un-hides internal routes and marks them', () => {
      const result = transform(transformInput({ hide: true, visibility: 'internal' }))

      expect(result.schema).toEqual({ hide: false, 'x-internal': true })
    })

    it('leaves public routes untouched and unmarked', () => {
      const result = transform(transformInput({ hide: false, visibility: 'public' }))

      expect(result.schema).toEqual({ hide: false })
    })

    it('supports a custom marker key', () => {
      const custom = openApiVisibilityTransform({
        audience: 'internal',
        internalMarkerKey: 'x-audience-internal',
      })

      const result = custom(transformInput({ hide: true, visibility: 'internal' }))

      expect(result.schema).toEqual({ hide: false, 'x-audience-internal': true })
    })

    it('can leave internal operations unmarked', () => {
      const unmarked = openApiVisibilityTransform({
        audience: 'internal',
        markInternalOperations: false,
      })

      const result = unmarked(transformInput({ hide: true, visibility: 'internal' }))

      expect(result.schema).toEqual({ hide: false })
    })
  })

  describe('routes without a visibility marker', () => {
    it('surfaces already-hidden routes in the internal document by default', () => {
      const transform = openApiVisibilityTransform({ audience: 'internal' })

      const result = transform(transformInput({ hide: true }))

      expect(result.schema).toEqual({ hide: false, 'x-internal': true })
    })

    it('keeps them hidden when treatHiddenAsInternal is disabled', () => {
      const transform = openApiVisibilityTransform({
        audience: 'internal',
        treatHiddenAsInternal: false,
      })

      const result = transform(transformInput({ hide: true }))

      expect(result.schema).toEqual({ hide: true })
    })

    it('leaves undocumented-but-visible routes alone in both audiences', () => {
      const forPublic = openApiVisibilityTransform({ audience: 'public' })
      const forInternal = openApiVisibilityTransform({ audience: 'internal' })

      expect(forPublic(transformInput({ summary: 'health' })).schema).toEqual({ summary: 'health' })
      expect(forInternal(transformInput({ summary: 'health' })).schema).toEqual({
        summary: 'health',
      })
    })

    it('passes a missing schema straight through', () => {
      const transform = openApiVisibilityTransform({ audience: 'internal' })

      expect(transform(transformInput(undefined)).schema).toBeUndefined()
    })
  })

  it('never mutates the route schema shared between documents', () => {
    const schema: OpenApiRouteSchema = { hide: true, visibility: 'internal', summary: 'Internal' }

    const publicResult = openApiVisibilityTransform({ audience: 'public' })(transformInput(schema))
    const internalResult = openApiVisibilityTransform({ audience: 'internal' })(
      transformInput(schema),
    )

    expect(schema).toEqual({ hide: true, visibility: 'internal', summary: 'Internal' })
    expect(publicResult.schema).toEqual({ hide: true, summary: 'Internal' })
    expect(internalResult.schema).toEqual({
      hide: false,
      summary: 'Internal',
      'x-internal': true,
    })
  })

  describe('chained transform', () => {
    it('runs underneath the visibility decision, so it sees the audience-adjusted hide flag', () => {
      const inner = vi.fn((input: { schema: OpenApiRouteSchema; url: string }) => ({
        schema: { ...input.schema, description: 'converted' },
        url: input.url,
      }))
      const transform = openApiVisibilityTransform({ audience: 'internal', transform: inner })

      const result = transform(transformInput({ hide: true, visibility: 'internal' }))

      expect(inner).toHaveBeenCalledWith(
        expect.objectContaining({ schema: { hide: false }, url: '/api/items' }),
      )
      expect(result.schema).toEqual({ hide: false, description: 'converted', 'x-internal': true })
    })

    it('forwards the document object so the inner transform can read it', () => {
      const inner = vi.fn((input: { schema: OpenApiRouteSchema; url: string }) => ({
        schema: input.schema,
        url: input.url,
      }))
      const transform = openApiVisibilityTransform({ audience: 'public', transform: inner })

      transform(transformInput({ hide: false, visibility: 'public' }))

      expect(inner).toHaveBeenCalledWith(
        expect.objectContaining({ openapiObject: { openapi: '3.1.0' } }),
      )
    })
  })
})
