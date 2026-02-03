import { success } from '@lokalise/node-core'
import { createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  buildContract,
  buildFastifyRoute,
  DIContext,
  SSEInjectClient,
  SSETestServer,
} from '../../index.js'
import type {
  GenericDualModeController,
  TestMultiFormatExportController,
  TestMultiFormatReportController,
} from './fixtures/testControllers.js'
import {
  GenericDualModeModule,
  TestMultiFormatExportModule,
  TestMultiFormatReportModule,
} from './fixtures/testModules.js'

/**
 * Multi-Format Route E2E Tests
 *
 * These tests verify that verbose dual-mode contracts with multiFormatResponses:
 * 1. Route to the correct sync handler based on Accept header
 * 2. Set Content-Type correctly for each format
 * 3. Handle quality value negotiation
 * 4. Fall back to SSE for text/event-stream
 * 5. Use default format when no Accept header matches
 */

describe('Multi-Format Accept Header Routing', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestMultiFormatExportModule()] }, undefined)

    const controller: TestMultiFormatExportController = context.diContainer.resolve(
      'testMultiFormatExportController',
    )

    const routes = controller.buildDualModeRoutes()

    server = await SSETestServer.create(
      (app) => {
        app.route(buildFastifyRoute(controller, routes.export))
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
    await context.destroy()
    await server.close()
  })

  it('returns JSON response for Accept: application/json', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/export',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      payload: {
        data: [
          { name: 'item1', value: 10 },
          { name: 'item2', value: 20 },
        ],
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')
    expect(response.json()).toEqual({
      items: [
        { name: 'item1', value: 10 },
        { name: 'item2', value: 20 },
      ],
      count: 2,
    })
  })

  it('returns plain text response for Accept: text/plain', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/export',
      headers: {
        'content-type': 'application/json',
        accept: 'text/plain',
      },
      payload: {
        data: [
          { name: 'item1', value: 10 },
          { name: 'item2', value: 20 },
        ],
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/plain')
    expect(response.body).toBe('item1: 10\nitem2: 20')
  })

  it('returns CSV response for Accept: text/csv', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/export',
      headers: {
        'content-type': 'application/json',
        accept: 'text/csv',
      },
      payload: {
        data: [
          { name: 'item1', value: 10 },
          { name: 'item2', value: 20 },
        ],
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/csv')
    expect(response.body).toBe('name,value\nitem1,10\nitem2,20')
  })

  it('streams SSE for Accept: text/event-stream', async () => {
    const injectClient = new SSEInjectClient(server.app)

    const conn = await injectClient.connectWithBody('/api/export', {
      data: [
        { name: 'item1', value: 10 },
        { name: 'item2', value: 20 },
      ],
    })

    const events = conn.getReceivedEvents()

    // Should receive progress events and done event
    expect(events.length).toBeGreaterThan(0)
    const doneEvent = events.find((e) => e.event === 'done')
    expect(doneEvent).toBeDefined()
    expect(JSON.parse(doneEvent!.data)).toEqual({ totalItems: 2 })
  })

  it('uses first format as default when Accept header is */*', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/export',
      headers: {
        'content-type': 'application/json',
        accept: '*/*',
      },
      payload: {
        data: [{ name: 'item1', value: 10 }],
      },
    })

    expect(response.statusCode).toBe(200)
    // First format in multiFormatResponses is application/json
    expect(response.headers['content-type']).toContain('application/json')
  })

  it('handles quality value negotiation', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/export',
      headers: {
        'content-type': 'application/json',
        accept: 'text/plain;q=0.5, application/json;q=0.9, text/csv;q=0.8',
      },
      payload: {
        data: [{ name: 'item1', value: 10 }],
      },
    })

    expect(response.statusCode).toBe(200)
    // Should prefer application/json (q=0.9) over text/csv (q=0.8) and text/plain (q=0.5)
    expect(response.headers['content-type']).toContain('application/json')
  })
})

describe('Multi-Format GET Routes', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestMultiFormatReportModule()] }, undefined)

    const controller: TestMultiFormatReportController = context.diContainer.resolve(
      'testMultiFormatReportController',
    )

    const routes = controller.buildDualModeRoutes()

    server = await SSETestServer.create(
      (app) => {
        app.route(buildFastifyRoute(controller, routes.report))
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
    await context.destroy()
    await server.close()
  })

  it('returns JSON for GET with Accept: application/json', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/reports/report-123',
      headers: {
        accept: 'application/json',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')
    expect(response.json()).toEqual({
      id: 'report-123',
      title: 'Report report-123',
      data: { detailed: false },
    })
  })

  it('returns plain text for GET with Accept: text/plain', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/reports/report-456?detailed=true',
      headers: {
        accept: 'text/plain',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/plain')
    expect(response.body).toBe('Report: report-456\nDetailed: true')
  })

  it('streams SSE for GET with Accept: text/event-stream', async () => {
    const injectClient = new SSEInjectClient(server.app)

    const conn = await injectClient.connect('/api/reports/report-789')
    const events = conn.getReceivedEvents()

    expect(events.length).toBe(2)
    expect(events[0]?.event).toBe('chunk')
    expect(JSON.parse(events[0]?.data ?? '{}')).toEqual({
      content: 'Streaming report report-789',
    })
    expect(events[1]?.event).toBe('done')
    expect(JSON.parse(events[1]?.data ?? '{}')).toEqual({ totalSize: 100 })
  })
})

describe('Multi-Format Response Validation', () => {
  it('validates sync response against format schema', async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new GenericDualModeModule()] }, undefined)

    const controller: GenericDualModeController = context.diContainer.resolve(
      'genericDualModeController',
    )

    // Contract with strict validation
    const contract = buildContract({
      method: 'POST',
      pathResolver: () => '/api/validated',
      params: z.object({}),
      query: z.object({}),
      requestHeaders: z.object({}),
      requestBody: z.object({ value: z.string() }),
      multiFormatResponses: {
        'application/json': z.object({ result: z.string(), count: z.number().positive() }),
        'text/plain': z.string().min(1),
      },
      events: { done: z.object({ ok: z.boolean() }) },
    })

    const route = buildFastifyRoute(controller, {
      contract,
      handlers: {
        sync: {
          'application/json': () => ({ result: 'ok', count: 5 }),
          'text/plain': () => 'Valid response',
        },
        sse: async (_req, conn) => {
          await conn.send('done', { ok: true })
          return success('disconnect')
        },
      },
    })

    const server = await SSETestServer.create(
      (app) => {
        app.route(route)
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ context }),
      },
    )

    // Test JSON validation
    const jsonResponse = await server.app.inject({
      method: 'POST',
      url: '/api/validated',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      payload: { value: 'test' },
    })

    expect(jsonResponse.statusCode).toBe(200)
    expect(jsonResponse.json()).toEqual({ result: 'ok', count: 5 })

    // Test plain text validation
    const textResponse = await server.app.inject({
      method: 'POST',
      url: '/api/validated',
      headers: { 'content-type': 'application/json', accept: 'text/plain' },
      payload: { value: 'test' },
    })

    expect(textResponse.statusCode).toBe(200)
    expect(textResponse.body).toBe('Valid response')

    await context.destroy()
    await server.close()
  })

  it('falls back to first format when Accept header is unsupported', async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new GenericDualModeModule()] }, undefined)

    const controller: GenericDualModeController = context.diContainer.resolve(
      'genericDualModeController',
    )

    const contract = buildContract({
      method: 'POST',
      pathResolver: () => '/api/fallback-test',
      params: z.object({}),
      query: z.object({}),
      requestHeaders: z.object({}),
      requestBody: z.object({ value: z.string() }),
      multiFormatResponses: {
        'application/json': z.object({ result: z.string() }),
        'text/plain': z.string(),
      },
      events: { done: z.object({ ok: z.boolean() }) },
    })

    const route = buildFastifyRoute(controller, {
      contract,
      handlers: {
        sync: {
          'application/json': () => ({ result: 'json-response' }),
          'text/plain': () => 'plain-text-response',
        },
        sse: async (_req, conn) => {
          await conn.send('done', { ok: true })
          return success('disconnect')
        },
      },
    })

    const server = await SSETestServer.create(
      (app) => {
        app.route(route)
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ context }),
      },
    )

    // Request an unsupported format (text/xml) - should fall back to first format (application/json)
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/fallback-test',
      headers: { 'content-type': 'application/json', accept: 'text/xml' },
      payload: { value: 'test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')
    expect(response.json()).toEqual({ result: 'json-response' })

    await context.destroy()
    await server.close()
  })
})
