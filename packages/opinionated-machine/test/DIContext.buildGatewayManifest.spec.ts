import { createContainer } from 'awilix'
import { describe, expect, it } from 'vitest'
import { DIContext } from '../lib/DIContext.js'
import { TestModule, type TestModuleDependencies } from './TestModule.js'

// biome-ignore lint/complexity/noBannedTypes: shape mirrors test/DIContext.spec.ts
type Config = {}

function createContext() {
  const container = createContainer<TestModuleDependencies>({ injectionMode: 'PROXY' })
  const context = new DIContext<TestModuleDependencies, Config>(container, {}, {})
  context.registerDependencies({ modules: [new TestModule()] }, undefined)
  return context
}

describe('DIContext.buildGatewayManifest', () => {
  it('discovers all routes registered through controllers', () => {
    const manifest = createContext().buildGatewayManifest({ service: 'test-service' })

    expect(manifest.service).toBe('test-service')
    expect(manifest.manifestVersion).toBe('1')
    expect(manifest.routes.length).toBeGreaterThan(0)

    const ids = manifest.routes.map((r) => r.id).sort()
    expect(ids).toContain('testController.getItem')
    expect(ids).toContain('testController.deleteItem')
    expect(ids).toContain('testController.updateItem')
    expect(ids).toContain('testController.createItem')
  })

  it('emits OpenAPI-style paths', () => {
    const manifest = createContext().buildGatewayManifest({ service: 'test-service' })
    const getItem = manifest.routes.find((r) => r.routeKey === 'getItem')
    expect(getItem?.path).toBe('/users/{userId}')
    expect(getItem?.method).toBe('GET')
  })

  it('reads metadata from withGatewayMetadata and leaves un-annotated routes empty', () => {
    const manifest = createContext().buildGatewayManifest({ service: 'test-service' })
    const getItem = manifest.routes.find((r) => r.routeKey === 'getItem')
    const deleteItem = manifest.routes.find((r) => r.routeKey === 'deleteItem')
    expect(getItem?.metadata).toEqual({ cache: { ttl: '60s' } })
    expect(deleteItem?.metadata).toEqual({})
  })

  it('applies service-wide defaults to every route, deep-merging into route metadata', () => {
    const manifest = createContext().buildGatewayManifest({
      service: 'test-service',
      defaults: { timeouts: { request: '5s' }, tags: ['rest'] },
    })
    for (const route of manifest.routes) {
      expect(route.metadata.timeouts).toEqual({ request: '5s' })
      expect(route.metadata.tags).toEqual(['rest'])
    }
    // Defaults coexist with route-level metadata.
    const getItem = manifest.routes.find((r) => r.routeKey === 'getItem')
    expect(getItem?.metadata.cache).toEqual({ ttl: '60s' })
  })

  it('routes are sorted deterministically by path then method', () => {
    const manifest = createContext().buildGatewayManifest({ service: 'test-service' })
    const sortKey = (m: { path: string; method: string }) => `${m.path} ${m.method}`
    const sorted = [...manifest.routes].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
    expect(manifest.routes).toEqual(sorted)
  })
})
