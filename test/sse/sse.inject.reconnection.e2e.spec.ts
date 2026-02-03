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
  asyncReconnectStreamContract,
  reconnectStreamContract,
} from './fixtures/testContracts.js'
import {
  TestReconnectSSEModule,
  type TestReconnectSSEModuleDependencies,
} from './fixtures/testModules.js'

/**
 * Tests for SSE Last-Event-ID reconnection mechanism.
 *
 * How SSE reconnection works:
 * 1. Client connects and receives events, each with an `id` field
 * 2. Client disconnects (network error, server restart, etc.)
 * 3. Browser automatically reconnects and sends `Last-Event-ID` header with the last received event ID
 * 4. Server's `onReconnect` handler receives this ID and replays missed events
 *
 * These tests simulate step 3 by sending the `Last-Event-ID` header directly.
 * The server doesn't track previous sessions - it just responds to the header.
 */
describe('SSE Inject E2E (Last-Event-ID reconnection)', () => {
  let server: SSETestServer<{ context: DIContext<TestReconnectSSEModuleDependencies, object> }>
  let context: DIContext<TestReconnectSSEModuleDependencies, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<TestReconnectSSEModuleDependencies, object>(
      container,
      { isTestMode: true },
      {},
    )
    context.registerDependencies({ modules: [new TestReconnectSSEModule()] }, undefined)

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

  it('replays events after Last-Event-ID on reconnection', { timeout: 10000 }, async () => {
    // Use injectSSE with Last-Event-ID header to simulate reconnection
    const { closed } = injectSSE(server.app, reconnectStreamContract, {
      headers: { 'last-event-id': '2' } as Record<string, string>,
    })

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    // Should replay events 3, 4, 5 (after id 2) plus the new event 6
    const eventDatas = events.map((e) => JSON.parse(e.data))

    // Events 3, 4, 5 are replayed, then 6 is sent by the handler
    expect(eventDatas).toContainEqual({ id: '3', data: 'Third event' })
    expect(eventDatas).toContainEqual({ id: '4', data: 'Fourth event' })
    expect(eventDatas).toContainEqual({ id: '5', data: 'Fifth event' })
    expect(eventDatas).toContainEqual({ id: '6', data: 'New event after reconnect' })
  })

  it('sends only new events when reconnecting with latest ID', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, reconnectStreamContract, {
      headers: { 'last-event-id': '5' } as Record<string, string>,
    })

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    // No events to replay after id 5, just the new event 6
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0]!.data)).toEqual({ id: '6', data: 'New event after reconnect' })
  })

  it('connects without replay when no Last-Event-ID', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, reconnectStreamContract, {})

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    // Just the new event, no replay
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0]!.data)).toEqual({ id: '6', data: 'New event after reconnect' })
  })

  it('replays events using async iterable', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, asyncReconnectStreamContract, {
      headers: { 'last-event-id': '1' },
    })

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    const eventDatas = events.map((e) => JSON.parse(e.data))

    // Events 2, 3 are replayed via async generator, then 4 is sent by handler
    expect(eventDatas).toContainEqual({ id: '2', data: 'Async second event' })
    expect(eventDatas).toContainEqual({ id: '3', data: 'Async third event' })
    expect(eventDatas).toContainEqual({ id: '4', data: 'Async new event after reconnect' })
  })

  it('async replay works with no events to replay', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, asyncReconnectStreamContract, {
      headers: { 'last-event-id': '3' },
    })

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    // No events to replay after id 3, just the new event 4
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0]!.data)).toEqual({
      id: '4',
      data: 'Async new event after reconnect',
    })
  })
})
