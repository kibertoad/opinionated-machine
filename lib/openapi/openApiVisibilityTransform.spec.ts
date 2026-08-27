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

    it('rejects a marker key @fastify/swagger would drop', () => {
      // Without the `x-` prefix the marker never reaches the document, so
      // `stripInternalOperations` would match nothing and publish every
      // internal operation. There is no later point at which that is visible.
      expect(() =>
        openApiVisibilityTransform({ audience: 'internal', internalMarkerKey: 'internal' }),
      ).toThrow(/must be an OpenAPI extension key starting with "x-"/)
      expect(() =>
        openApiVisibilityTransform({ audience: 'internal', internalMarkerKey: 'x-' }),
      ).toThrow(/must be an OpenAPI extension key starting with "x-"/)
    })

    it('rejects the marker key for the public audience too, so the pair cannot drift', () => {
      expect(() =>
        openApiVisibilityTransform({ audience: 'public', internalMarkerKey: 'internal' }),
      ).toThrow(/must be an OpenAPI extension key starting with "x-"/)
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

  describe('exclude', () => {
    const excludeDocs = { exclude: ({ url }: { url: string }) => url.startsWith('/documentation') }

    it('hides a matching route in every audience', () => {
      for (const audience of ['public', 'internal'] as const) {
        const transform = openApiVisibilityTransform({ audience, ...excludeDocs })

        const result = transform(transformInput({ hide: true }, '/documentation/json'))

        expect(result.schema).toEqual({ hide: true })
      }
    })

    it('hides a matching route even when its contract is public', () => {
      const transform = openApiVisibilityTransform({ audience: 'public', ...excludeDocs })

      const result = transform(
        transformInput({ hide: false, visibility: 'public' }, '/documentation/json'),
      )

      expect(result.schema).toEqual({ hide: true })
    })

    it('never marks an excluded route, so nothing derives it back', () => {
      const transform = openApiVisibilityTransform({ audience: 'internal', ...excludeDocs })

      const result = transform(transformInput({ hide: true }, '/documentation/json'))

      expect(result.schema).not.toHaveProperty('x-internal')
    })

    it('hides a matching route that has no schema at all', () => {
      const transform = openApiVisibilityTransform({ audience: 'internal', ...excludeDocs })

      const result = transform(transformInput(undefined, '/documentation/json'))

      expect(result.schema).toEqual({ hide: true })
    })

    it('leaves routes it does not match to the audience rules', () => {
      const transform = openApiVisibilityTransform({ audience: 'internal', ...excludeDocs })

      const result = transform(transformInput({ hide: true, visibility: 'internal' }, '/api/items'))

      expect(result.schema).toEqual({ hide: false, 'x-internal': true })
    })

    it('does not mutate the excluded route schema', () => {
      const schema: OpenApiRouteSchema = { hide: false, visibility: 'public' }
      const transform = openApiVisibilityTransform({ audience: 'internal', ...excludeDocs })

      transform(transformInput(schema, '/documentation/json'))

      expect(schema).toEqual({ hide: false, visibility: 'public' })
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
