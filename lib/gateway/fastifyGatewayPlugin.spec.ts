import { createContainer } from 'awilix'
import { fastify } from 'fastify'
import { describe, expect, it } from 'vitest'
import { TestModule, type TestModuleDependencies } from '../../test/TestModule.ts'
import { DIContext } from '../DIContext.ts'
import { fastifyGatewayPlugin } from './fastifyGatewayPlugin.ts'

// biome-ignore lint/complexity/noBannedTypes: shape mirrors test/DIContext.spec.ts
type Config = {}

function createContext() {
  const container = createContainer<TestModuleDependencies>({ injectionMode: 'PROXY' })
  const context = new DIContext<TestModuleDependencies, Config>(container, {}, {})
  context.registerDependencies({ modules: [new TestModule()] }, undefined)
  return context
}

describe('fastifyGatewayPlugin', () => {
  it('decorates app.buildGatewayManifest()', async () => {
    const app = fastify()
    await app.register(fastifyGatewayPlugin, {
      context: createContext(),
      defaults: { service: 'users-api' },
    })
    const manifest = app.buildGatewayManifest()
    expect(manifest.service).toBe('users-api')
    expect(manifest.routes.length).toBeGreaterThan(0)
    await app.close()
  })

  it('does NOT register an HTTP route by default (manifest exposure is opt-in)', async () => {
    const app = fastify()
    await app.register(fastifyGatewayPlugin, {
      context: createContext(),
      defaults: { service: 'users-api' },
    })
    const res = await app.inject({ method: 'GET', url: '/_gateway/manifest' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('exposes the manifest over HTTP when exposeRoute is set', async () => {
    const app = fastify()
    await app.register(fastifyGatewayPlugin, {
      context: createContext(),
      defaults: { service: 'users-api' },
      exposeRoute: '/__gateway/manifest',
    })
    const res = await app.inject({ method: 'GET', url: '/__gateway/manifest' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { service: string; manifestVersion: string }
    expect(body.service).toBe('users-api')
    expect(body.manifestVersion).toBe('1')
    await app.close()
  })

  it('overrides merge into defaults at call time', async () => {
    const app = fastify()
    await app.register(fastifyGatewayPlugin, {
      context: createContext(),
      defaults: { service: 'default-name' },
    })
    const manifest = app.buildGatewayManifest({ service: 'override' })
    expect(manifest.service).toBe('override')
    await app.close()
  })
})
