import { createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DIContext,
  injectSSE,
  parseSSEEvents,
  SSETestServer,
} from '../../index.js'
import {
  authenticatedStreamContract,
  channelStreamContract,
} from './fixtures/testContracts.js'
import {
  TestAuthSSEModule,
  TestChannelSSEModule,
} from './fixtures/testModules.js'

describe('SSE Inject E2E (authentication)', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestAuthSSEModule()] }, undefined)

    server = await SSETestServer.create(
      (app) => {
        context.registerSSERoutes(app)
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ context }),
      },
    )
  })

  afterEach(async () => {
    await server.resources.context.destroy()
    await server.close()
  })

  it('rejects requests without authorization header', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, authenticatedStreamContract, {
      headers: { authorization: '' },
    })

    const response = await closed

    expect(response.statusCode).toBe(401)
  })

  it('rejects requests with invalid authorization format', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, authenticatedStreamContract, {
      headers: { authorization: 'Basic invalid' },
    })

    const response = await closed

    expect(response.statusCode).toBe(401)
  })

  it('accepts requests with valid Bearer token', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, authenticatedStreamContract, {
      headers: { authorization: 'Bearer valid-token' },
    })

    const response = await closed

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')

    const events = parseSSEEvents(response.body)
    expect(events).toHaveLength(1)
    expect(events[0]!.event).toBe('data')
    expect(JSON.parse(events[0]!.data)).toEqual({ value: 'authenticated data' })
  })
})

describe('SSE Inject E2E (path parameters)', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestChannelSSEModule()] }, undefined)

    server = await SSETestServer.create(
      (app) => {
        context.registerSSERoutes(app)
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ context }),
      },
    )
  })

  afterEach(async () => {
    await server.resources.context.destroy()
    await server.close()
  })

  it('handles path parameters correctly', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, channelStreamContract, {
      params: { channelId: 'general' },
    })

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    expect(events).toHaveLength(1)
    expect(events[0]!.event).toBe('message')
    expect(JSON.parse(events[0]!.data)).toEqual({
      id: '1',
      content: 'Welcome to channel general',
      author: 'system',
    })
  })

  it('handles different channel IDs', { timeout: 10000 }, async () => {
    const channelIds = ['channel-1', 'lobby', 'support-123']

    for (const channelId of channelIds) {
      const { closed } = injectSSE(server.app, channelStreamContract, {
        params: { channelId },
      })

      const response = await closed
      const events = parseSSEEvents(response.body)

      expect(JSON.parse(events[0]!.data).content).toBe(`Welcome to channel ${channelId}`)
    }
  })

  it('handles path params with query params together', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, channelStreamContract, {
      params: { channelId: 'test-channel' },
      query: { since: '2024-01-01' },
    })

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0]!.data).content).toBe('Welcome to channel test-channel')
  })

  it('filters out undefined and null query params', { timeout: 10000 }, async () => {
    // Query params with undefined/null values should be filtered out
    const { closed } = injectSSE(server.app, channelStreamContract, {
      params: { channelId: 'filter-test' },
      query: { since: undefined, other: null } as Record<string, unknown>,
    })

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0]!.data).content).toBe('Welcome to channel filter-test')
  })
})
