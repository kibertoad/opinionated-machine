import { createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DIContext, injectSSE } from '../../index.js'
import { createSSETestServer, type SSETestServerWithResources } from '../sseTestServerFactory.js'
import { bodyForStatusGetContract } from './fixtures/testContracts.js'
import {
  TestBodyForStatusModule,
  type TestBodyForStatusModuleDependencies,
} from './fixtures/testModules.js'

describe('injectSSE — bodyForStatus typed accessor', () => {
  let server: SSETestServerWithResources<{
    context: DIContext<TestBodyForStatusModuleDependencies, object>
  }>
  let context: DIContext<TestBodyForStatusModuleDependencies, object>

  beforeEach(async () => {
    const container = createContainer<TestBodyForStatusModuleDependencies>({
      injectionMode: 'PROXY',
    })
    context = new DIContext<TestBodyForStatusModuleDependencies, object>(
      container,
      { isTestMode: true },
      {},
    )
    context.registerDependencies({ modules: [new TestBodyForStatusModule()] }, undefined)

    server = await createSSETestServer(
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
    await context.destroy()
    await server.close()
  })

  it('parses the body against the contract schema for the matching status (401)', async () => {
    const { bodyForStatus } = injectSSE(server.app, bodyForStatusGetContract, {
      query: { mode: 'unauthorized' },
    })

    const body = await bodyForStatus(401)

    // `body` is typed as `{ message: string }` (the 401 schema). The
    // assertion checks both shape and value end-to-end.
    expect(body).toEqual({ message: 'Unauthorized' })
  })

  it('parses the body against the contract schema for the matching status (404)', async () => {
    const { bodyForStatus } = injectSSE(server.app, bodyForStatusGetContract, {
      query: { mode: 'missing' },
    })

    const body = await bodyForStatus(404)

    expect(body).toEqual({ resourceId: 'item-42' })
  })

  it('throws when the actual status does not match the expected one', async () => {
    const { bodyForStatus } = injectSSE(server.app, bodyForStatusGetContract, {
      query: { mode: 'unauthorized' },
    })

    await expect(bodyForStatus(404)).rejects.toThrow(/actual status 401/)
  })

  it('exposes the same raw body via closed', async () => {
    // Sanity check that the original `closed` API still works alongside
    // bodyForStatus — they read from the same underlying inject result.
    const { closed } = injectSSE(server.app, bodyForStatusGetContract, {
      query: { mode: 'unauthorized' },
    })
    const res = await closed
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body)).toEqual({ message: 'Unauthorized' })
  })
})
