import { createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { describe, expect, it } from 'vitest'
import { DIContext, parseSSEEvents, SSETestServer } from '../../index.js'
import type { TestSSEController } from './fixtures/testControllers.js'
import { TestSSEModule } from './fixtures/testModules.js'

describe('SSE Inject E2E (deprecated setupSSESession)', () => {
  it('setupSSESession backwards compat function works', { timeout: 10000 }, async () => {
    const { setupSSESession } = await import('../../lib/routes/fastifyRouteUtils.js')
    const { z } = await import('zod/v4')

    // Create event schemas directly
    const eventSchemas = {
      message: z.object({ text: z.string() }),
    }

    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

    // Get the controller from the module
    const controller = context.diContainer.resolve<TestSSEController>('testSSEController')

    const server = await SSETestServer.create(
      (app) => {
        // Use the deprecated setupSSESession directly in a custom route
        app.route({
          method: 'GET',
          url: '/test/legacy-setup',
          sse: true,
          handler: async (request, reply) => {
            const result = await setupSSESession(
              controller,
              request,
              reply,
              eventSchemas,
              undefined,
              'LegacyTest',
            )

            await result.connection.send('message', { text: 'from legacy setup' })

            // Close connection
            result.sseReply.sse.close()
            await result.connectionClosed
          },
        })
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ context }),
      },
    )

    const response = await server.app.inject({
      method: 'GET',
      url: '/test/legacy-setup',
      headers: { accept: 'text/event-stream' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')

    const events = parseSSEEvents(response.body)
    expect(events).toHaveLength(1)
    expect(events[0]!.event).toBe('message')
    expect(JSON.parse(events[0]!.data)).toEqual({ text: 'from legacy setup' })

    await context.destroy()
    await server.close()
  })
})

describe('SSE Inject E2E (sendHeaders and context helpers)', () => {
  it('sendHeaders() sends SSE headers for manual streaming', { timeout: 10000 }, async () => {
    const { createSSEContext } = await import('../../lib/routes/fastifyRouteUtils.js')
    const { z } = await import('zod/v4')

    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

    const controller = context.diContainer.resolve<TestSSEController>('testSSEController')

    const server = await SSETestServer.create(
      (app) => {
        app.route({
          method: 'GET',
          url: '/test/send-headers',
          sse: true,
          handler: (request, reply) => {
            const eventSchemas = { message: z.object({ text: z.string() }) }
            const result = createSSEContext(controller, request, reply, eventSchemas, undefined)

            // Use sendHeaders for manual control
            result.sseContext.sendHeaders()

            // Use reply.sse directly for manual event sending
            result.sseReply.sse.send({ event: 'message', data: JSON.stringify({ text: 'manual' }) })

            // Close via reply.sse
            result.sseReply.sse.close()
          },
        })
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ context }),
      },
    )

    const response = await server.app.inject({
      method: 'GET',
      url: '/test/send-headers',
      headers: { accept: 'text/event-stream' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')

    const events = parseSSEEvents(response.body)
    expect(events).toHaveLength(1)
    expect(events[0]!.event).toBe('message')

    await context.destroy()
    await server.close()
  })

  it('hasResponse() returns true after sse.respond() is called', { timeout: 10000 }, async () => {
    const { createSSEContext } = await import('../../lib/routes/fastifyRouteUtils.js')
    const { z } = await import('zod/v4')

    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

    const controller = context.diContainer.resolve<TestSSEController>('testSSEController')
    let hasErrorResult = false

    const server = await SSETestServer.create(
      (app) => {
        app.route({
          method: 'GET',
          url: '/test/has-error',
          sse: true,
          handler: (request, reply) => {
            const eventSchemas = { message: z.object({ text: z.string() }) }
            const result = createSSEContext(controller, request, reply, eventSchemas, undefined)

            // Call respond
            const respondResult = result.sseContext.respond(400, { error: 'test' })

            // Check hasError
            hasErrorResult = result.hasResponse()

            // Process the respond result
            reply.code(respondResult.code).send(respondResult.body)
          },
        })
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ context }),
      },
    )

    const response = await server.app.inject({
      method: 'GET',
      url: '/test/has-error',
      headers: { accept: 'text/event-stream' },
    })

    expect(response.statusCode).toBe(400)
    expect(hasErrorResult).toBe(true)

    await context.destroy()
    await server.close()
  })

  it('sendHeaders() throws if called after start()', { timeout: 10000 }, async () => {
    const { createSSEContext } = await import('../../lib/routes/fastifyRouteUtils.js')
    const { z } = await import('zod/v4')

    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

    const controller = context.diContainer.resolve<TestSSEController>('testSSEController')
    let thrownError: Error | null = null

    const server = await SSETestServer.create(
      (app) => {
        app.route({
          method: 'GET',
          url: '/test/send-headers-after-start',
          sse: true,
          handler: async (request, reply) => {
            const eventSchemas = { message: z.object({ text: z.string() }) }
            const result = createSSEContext(controller, request, reply, eventSchemas, undefined)

            // First start streaming
            const connection = result.sseContext.start('autoClose')

            // Then try sendHeaders - should throw
            try {
              result.sseContext.sendHeaders()
            } catch (e) {
              thrownError = e as Error
            }

            await connection.send('message', { text: 'test' })
            result.sseReply.sse.close()
            await result.connectionClosed
          },
        })
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ context }),
      },
    )

    await server.app.inject({
      method: 'GET',
      url: '/test/send-headers-after-start',
      headers: { accept: 'text/event-stream' },
    })

    expect(thrownError).not.toBeNull()
    expect(thrownError!.message).toContain('Headers already sent')

    await context.destroy()
    await server.close()
  })

  it('sendHeaders() throws if called after respond()', { timeout: 10000 }, async () => {
    const { createSSEContext } = await import('../../lib/routes/fastifyRouteUtils.js')
    const { z } = await import('zod/v4')

    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

    const controller = context.diContainer.resolve<TestSSEController>('testSSEController')
    let thrownError: Error | null = null

    const server = await SSETestServer.create(
      (app) => {
        app.route({
          method: 'GET',
          url: '/test/send-headers-after-respond',
          sse: true,
          handler: (request, reply) => {
            const eventSchemas = { message: z.object({ text: z.string() }) }
            const result = createSSEContext(controller, request, reply, eventSchemas, undefined)

            // First send response
            const respondResult = result.sseContext.respond(400, { error: 'test' })

            // Then try sendHeaders - should throw
            try {
              result.sseContext.sendHeaders()
            } catch (e) {
              thrownError = e as Error
            }

            reply.code(respondResult.code).send(respondResult.body)
          },
        })
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ context }),
      },
    )

    await server.app.inject({
      method: 'GET',
      url: '/test/send-headers-after-respond',
      headers: { accept: 'text/event-stream' },
    })

    expect(thrownError).not.toBeNull()
    expect(thrownError!.message).toContain('Cannot send headers after sending a response')

    await context.destroy()
    await server.close()
  })

  it('start() throws if called twice', { timeout: 10000 }, async () => {
    const { createSSEContext } = await import('../../lib/routes/fastifyRouteUtils.js')
    const { z } = await import('zod/v4')

    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

    const controller = context.diContainer.resolve<TestSSEController>('testSSEController')
    let thrownError: Error | null = null

    const server = await SSETestServer.create(
      (app) => {
        app.route({
          method: 'GET',
          url: '/test/start-twice',
          sse: true,
          handler: async (request, reply) => {
            const eventSchemas = { message: z.object({ text: z.string() }) }
            const result = createSSEContext(controller, request, reply, eventSchemas, undefined)

            // First start
            const connection = result.sseContext.start('autoClose')

            // Try to start again - should throw
            try {
              result.sseContext.start('autoClose')
            } catch (e) {
              thrownError = e as Error
            }

            await connection.send('message', { text: 'test' })
            result.sseReply.sse.close()
            await result.connectionClosed
          },
        })
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ context }),
      },
    )

    await server.app.inject({
      method: 'GET',
      url: '/test/start-twice',
      headers: { accept: 'text/event-stream' },
    })

    expect(thrownError).not.toBeNull()
    expect(thrownError!.message).toContain('SSE streaming already started')

    await context.destroy()
    await server.close()
  })

  it('start() throws if called after respond()', { timeout: 10000 }, async () => {
    const { createSSEContext } = await import('../../lib/routes/fastifyRouteUtils.js')
    const { z } = await import('zod/v4')

    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

    const controller = context.diContainer.resolve<TestSSEController>('testSSEController')
    let thrownError: Error | null = null

    const server = await SSETestServer.create(
      (app) => {
        app.route({
          method: 'GET',
          url: '/test/start-after-respond',
          sse: true,
          handler: (request, reply) => {
            const eventSchemas = { message: z.object({ text: z.string() }) }
            const result = createSSEContext(controller, request, reply, eventSchemas, undefined)

            // First send response
            const respondResult = result.sseContext.respond(400, { error: 'test' })

            // Try to start - should throw
            try {
              result.sseContext.start('autoClose')
            } catch (e) {
              thrownError = e as Error
            }

            reply.code(respondResult.code).send(respondResult.body)
          },
        })
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ context }),
      },
    )

    await server.app.inject({
      method: 'GET',
      url: '/test/start-after-respond',
      headers: { accept: 'text/event-stream' },
    })

    expect(thrownError).not.toBeNull()
    expect(thrownError!.message).toContain('Cannot start streaming after sending a response')

    await context.destroy()
    await server.close()
  })

  it('respond() throws if called after start()', { timeout: 10000 }, async () => {
    const { createSSEContext } = await import('../../lib/routes/fastifyRouteUtils.js')
    const { z } = await import('zod/v4')

    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

    const controller = context.diContainer.resolve<TestSSEController>('testSSEController')
    let thrownError: Error | null = null

    const server = await SSETestServer.create(
      (app) => {
        app.route({
          method: 'GET',
          url: '/test/respond-after-start',
          sse: true,
          handler: async (request, reply) => {
            const eventSchemas = { message: z.object({ text: z.string() }) }
            const result = createSSEContext(controller, request, reply, eventSchemas, undefined)

            // First start streaming
            const session = result.sseContext.start('autoClose')

            // Then try respond - should throw
            try {
              result.sseContext.respond(400, { error: 'test' })
            } catch (e) {
              thrownError = e as Error
            }

            await session.send('message', { text: 'test' })
            result.sseReply.sse.close()
            await result.connectionClosed
          },
        })
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ context }),
      },
    )

    await server.app.inject({
      method: 'GET',
      url: '/test/respond-after-start',
      headers: { accept: 'text/event-stream' },
    })

    expect(thrownError).not.toBeNull()
    expect(thrownError!.message).toContain('Cannot send response after streaming')

    await context.destroy()
    await server.close()
  })

  it('getConnection() returns connection after start()', { timeout: 10000 }, async () => {
    const { createSSEContext } = await import('../../lib/routes/fastifyRouteUtils.js')
    const { z } = await import('zod/v4')

    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

    const controller = context.diContainer.resolve<TestSSEController>('testSSEController')
    let connectionFromGetter: unknown = null

    const server = await SSETestServer.create(
      (app) => {
        app.route({
          method: 'GET',
          url: '/test/get-connection',
          sse: true,
          handler: async (request, reply) => {
            const eventSchemas = { message: z.object({ text: z.string() }) }
            const result = createSSEContext(controller, request, reply, eventSchemas, undefined)

            // Start streaming
            const connection = result.sseContext.start('autoClose')

            // Get connection from getter
            connectionFromGetter = result.getConnection()

            await connection.send('message', { text: 'test' })
            result.sseReply.sse.close()
            await result.connectionClosed
          },
        })
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ context }),
      },
    )

    const response = await server.app.inject({
      method: 'GET',
      url: '/test/get-connection',
      headers: { accept: 'text/event-stream' },
    })

    expect(response.statusCode).toBe(200)
    expect(connectionFromGetter).not.toBeNull()
    expect((connectionFromGetter as { id: string }).id).toBeDefined()

    await context.destroy()
    await server.close()
  })
})
