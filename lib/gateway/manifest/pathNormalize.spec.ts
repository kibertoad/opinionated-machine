import { describe, expect, it } from 'vitest'
import { normalizePath } from './pathNormalize.ts'

describe('normalizePath', () => {
  it('passes through static paths unchanged', () => {
    expect(normalizePath('/users')).toBe('/users')
    expect(normalizePath('/')).toBe('/')
  })

  it('converts a single Fastify-style param', () => {
    expect(normalizePath('/users/:userId')).toBe('/users/{userId}')
  })

  it('converts multiple Fastify-style params', () => {
    expect(normalizePath('/users/:userId/posts/:postId')).toBe('/users/{userId}/posts/{postId}')
  })

  it('strips the optional marker from path text (optionality is metadata-level)', () => {
    expect(normalizePath('/users/:userId?')).toBe('/users/{userId}')
  })

  it('rewrites bare wildcards to {wildcard}', () => {
    expect(normalizePath('/files/*')).toBe('/files/{wildcard}')
  })

  it('preserves trailing slash exactly as authored', () => {
    expect(normalizePath('/users/:userId/')).toBe('/users/{userId}/')
  })

  it('rejects paths that do not start with /', () => {
    expect(() => normalizePath('users/:id')).toThrow(/start with/)
  })

  it('rejects invalid parameter names', () => {
    expect(() => normalizePath('/users/:1bad')).toThrow(/Invalid path parameter/)
  })
})
