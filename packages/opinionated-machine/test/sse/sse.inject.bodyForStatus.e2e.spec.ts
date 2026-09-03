import { createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest'
import { DIContext, injectPayloadSSE, injectSSE } from '../../index.js'
import { createSSETestServer, type SSETestServerWithResources } from '../sseTestServerFactory.js'
import { bodyForStatusGetContract, bodyForStatusPostContract } from './fixtures/testContracts.js'
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

    // `body` is statically typed as the contract's 401 schema, not `never`/`unknown`.
    expectTypeOf(body).toEqualTypeOf<{ message: string }>()
    expect(body).toEqual({ message: 'Unauthorized' })
  })

  it('parses the body against the contract schema for the matching status (404)', async () => {
    const { bodyForStatus } = injectSSE(server.app, bodyForStatusGetContract, {
      query: { mode: 'missing' },
    })

    const body = await bodyForStatus(404)

    expectTypeOf(body).toEqualTypeOf<{ resourceId: string }>()
    expect(body).toEqual({ resourceId: 'item-42' })
  })

  it('constrains bodyForStatus to the contract-declared status codes (type-level)', () => {
    // Regression guard: the schemas map must be inferred from the contract.
    // If it widens, the parameter would accept any HttpStatusCode and the
    // return type would collapse to `never`.
    const { bodyForStatus: getBodyForStatus } = injectSSE(server.app, bodyForStatusGetContract, {})
    const { bodyForStatus: postBodyForStatus } = injectPayloadSSE(
      server.app,
      bodyForStatusPostContract,
      { body: {} },
    )

    expectTypeOf(getBodyForStatus).parameter(0).toEqualTypeOf<401 | 404>()
    expectTypeOf(postBodyForStatus).parameter(0).toEqualTypeOf<401 | 404>()
  })

  it('throws when the actual status does not match the expected one', async () => {
    const { bodyForStatus } = injectSSE(server.app, bodyForStatusGetContract, {
      query: { mode: 'unauthorized' },
    })

    await expect(bodyForStatus(404)).rejects.toThrow(/actual status 401/)
  })

  it('rejects with a status mismatch when the route streams instead of responding', async () => {
    // `mode: 'ok'` starts a real SSE stream (status 200); bodyForStatus(401)
    // must reject on the status check rather than JSON-parsing event-stream text.
    const { bodyForStatus } = injectSSE(server.app, bodyForStatusGetContract, {
      query: { mode: 'ok' },
    })

    await expect(bodyForStatus(401)).rejects.toThrow(/actual status 200/)
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

  it('parses the body for injectPayloadSSE (POST) against the contract schema', async () => {
    const { bodyForStatus } = injectPayloadSSE(server.app, bodyForStatusPostContract, {
      body: { mode: 'unauthorized' },
    })

    const body = await bodyForStatus(401)

    expectTypeOf(body).toEqualTypeOf<{ message: string }>()
    expect(body).toEqual({ message: 'Unauthorized' })
  })

  it('throws on a status mismatch for injectPayloadSSE (POST)', async () => {
    const { bodyForStatus } = injectPayloadSSE(server.app, bodyForStatusPostContract, {
      body: { mode: 'missing' },
    })

    await expect(bodyForStatus(401)).rejects.toThrow(/actual status 404/)
  })
})
