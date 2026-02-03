import { createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildFastifyRoute,
  DIContext,
  injectPayloadSSE,
  injectSSE,
  parseSSEEvents,
  type SSELogger,
  SSETestServer,
} from '../../index.js'
import {
  getStreamTestContract,
  isConnectedTestStreamContract,
  onCloseErrorStreamContract,
  sendStreamTestContract,
} from './fixtures/testContracts.js'
import type { TestOnCloseErrorSSEController } from './fixtures/testControllers.js'
import {
  TestGetStreamSSEModule,
  TestIsConnectedSSEModule,
  TestOnCloseErrorSSEModule,
  type TestOnCloseErrorSSEModuleDependencies,
  TestSendStreamSSEModule,
} from './fixtures/testModules.js'

describe('SSE Inject E2E (onClose error handling)', () => {
  it('logs error when onClose callback throws', { timeout: 10000 }, async () => {
    const mockLogger: SSELogger = {
      error: vi.fn(),
    }

    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<TestOnCloseErrorSSEModuleDependencies, object>(
      container,
      { isTestMode: true },
      {},
    )
    context.registerDependencies(
      { modules: [new TestOnCloseErrorSSEModule(mockLogger)] },
      undefined,
    )

    const server = await SSETestServer.create(
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

    const { closed } = injectSSE(server.app, onCloseErrorStreamContract, {})

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    expect(events).toHaveLength(1)
    expect(events[0]!.event).toBe('message')
    expect(JSON.parse(events[0]!.data)).toEqual({ text: 'Hello before close' })

    // The logger.error should have been called when onClose threw
    // Note: This may be called asynchronously after the response completes
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(mockLogger.error).toHaveBeenCalled()

    await context.destroy()
    await server.close()
  })

  it(
    'passes reason "server" to onClose when server closes connection',
    { timeout: 10000 },
    async () => {
      const onCloseReason = vi.fn()
      const mockLogger: SSELogger = { error: vi.fn() }

      const container = createContainer({ injectionMode: 'PROXY' })
      const context = new DIContext<object, object>(container, { isTestMode: true }, {})
      context.registerDependencies(
        { modules: [new TestOnCloseErrorSSEModule(mockLogger)] },
        undefined,
      )

      const controller = context.diContainer.resolve(
        'testOnCloseErrorSSEController',
      ) as TestOnCloseErrorSSEController

      const server = await SSETestServer.create(
        (app) => {
          app.route(
            buildFastifyRoute(controller, {
              contract: onCloseErrorStreamContract,
              handlers: {
                sse: async (_request, sse) => {
                  const connection = sse.start('autoClose')
                  await connection.send('message', { text: 'Hello' })
                  // Server explicitly closes connection (autoClose mode)
                },
              },
              options: {
                onClose: (_conn, reason) => {
                  onCloseReason(reason)
                },
              },
            }),
          )
        },
        {
          configureApp: (app) => {
            app.setValidatorCompiler(validatorCompiler)
            app.setSerializerCompiler(serializerCompiler)
          },
          setup: () => ({ context }),
        },
      )

      const { closed } = injectSSE(server.app, onCloseErrorStreamContract, {})

      await closed

      // Wait for async callbacks to complete
      await new Promise((resolve) => setTimeout(resolve, 100))

      // onClose should have been called with reason 'server'
      expect(onCloseReason).toHaveBeenCalledTimes(1)
      expect(onCloseReason).toHaveBeenCalledWith('server')

      await context.destroy()
      await server.close()
    },
  )
})

describe('SSE Inject E2E (isConnected method)', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestIsConnectedSSEModule()] }, undefined)

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

  it('reports connected status correctly', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, isConnectedTestStreamContract, {})

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    expect(events).toHaveLength(2)

    const statusEvent = events.find((e) => e.event === 'status')
    expect(statusEvent).toBeDefined()
    expect(JSON.parse(statusEvent!.data)).toEqual({ connected: true })

    const doneEvent = events.find((e) => e.event === 'done')
    expect(doneEvent).toBeDefined()
    expect(JSON.parse(doneEvent!.data)).toEqual({ ok: true })
  })
})

describe('SSE Inject E2E (sendStream method)', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSendStreamSSEModule()] }, undefined)

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

  it('sends valid messages via sendStream', { timeout: 10000 }, async () => {
    const { closed } = injectPayloadSSE(server.app, sendStreamTestContract, {
      body: { sendInvalid: false },
    })

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    expect(events).toHaveLength(2)

    const messageEvent = events.find((e) => e.event === 'message')
    expect(messageEvent).toBeDefined()
    expect(JSON.parse(messageEvent!.data)).toEqual({ text: 'First message' })

    const doneEvent = events.find((e) => e.event === 'done')
    expect(doneEvent).toBeDefined()
    expect(JSON.parse(doneEvent!.data)).toEqual({ ok: true })
  })

  it('throws error when sendStream receives invalid data', { timeout: 10000 }, async () => {
    const { closed } = injectPayloadSSE(server.app, sendStreamTestContract, {
      body: { sendInvalid: true },
    })

    const response = await closed

    // The error should be handled and an error event should be sent
    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)

    // Should have received the first message before the validation error
    const messageEvent = events.find((e) => e.event === 'message')
    expect(messageEvent).toBeDefined()

    // Should have an error event due to validation failure
    const errorEvent = events.find((e) => e.event === 'error')
    expect(errorEvent).toBeDefined()
    const errorData = JSON.parse(errorEvent!.data)
    expect(errorData.message).toContain('SSE event validation failed')
  })
})

describe('SSE Inject E2E (getStream method)', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestGetStreamSSEModule()] }, undefined)

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

  it('provides access to raw stream', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, getStreamTestContract, {})

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    expect(events).toHaveLength(1)

    const messageEvent = events.find((e) => e.event === 'message')
    expect(messageEvent).toBeDefined()
    expect(JSON.parse(messageEvent!.data)).toEqual({ text: 'Got stream successfully' })
  })
})
