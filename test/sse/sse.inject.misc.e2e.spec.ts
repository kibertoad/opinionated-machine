import { createContainer } from 'awilix'
import { describe, expect, it } from 'vitest'
import { DIContext, SSEInjectConnection } from '../../index.js'
import type { TestSSEController } from './fixtures/testControllers.js'
import { TestSSEModule, type TestSSEModuleDependencies } from './fixtures/testModules.js'

describe('SSE Inject E2E (controller without spy)', () => {
  it('throws error when accessing connectionSpy without enableConnectionSpy', async () => {
    // Create a controller without spy enabled (isTestMode: false)
    const container = createContainer<TestSSEModuleDependencies>({ injectionMode: 'PROXY' })
    const context = new DIContext<TestSSEModuleDependencies, object>(
      container,
      { isTestMode: false }, // Spy not enabled
      {},
    )
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

    const controller = context.diContainer.resolve<TestSSEController>('testSSEController')

    expect(() => controller.connectionSpy).toThrow(
      'Connection spy is not enabled. Pass { enableConnectionSpy: true } to the constructor.',
    )

    await context.destroy()
  })
})

describe('SSE Inject E2E (SSEInjectConnection timeout paths)', () => {
  it('waitForEvent throws on timeout', async () => {
    // Create connection with no events (empty body)
    const connection = new SSEInjectConnection({
      statusCode: 200,
      headers: {},
      body: '',
    })

    await expect(connection.waitForEvent('nonexistent', 10)).rejects.toThrow(
      'Timeout waiting for event: nonexistent',
    )
  })

  it('waitForEvents throws on timeout when not enough events', async () => {
    // Create connection with only 1 event
    const connection = new SSEInjectConnection({
      statusCode: 200,
      headers: {},
      body: 'event: test\ndata: {}\n\n',
    })

    await expect(connection.waitForEvents(5, 10)).rejects.toThrow(
      'Timeout waiting for 5 events, received 1',
    )
  })
})
