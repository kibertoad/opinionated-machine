import { describe, expect, it } from 'vitest'
import { testContextFactory } from './ExampleTestContextFactory.js'
import { TestMessageQueueConsumer, TestModule } from './TestModule.js'
import { TestModuleSecondary } from './TestModuleSecondary.js'

describe('TestContext', () => {
  it('bootstraps for all modules', async () => {
    const testContext = await testContextFactory.createTestContext({
      diOptions: {
        messageQueueConsumersEnabled: [TestMessageQueueConsumer.QUEUE_ID],
        enqueuedJobWorkersEnabled: false,
      },
    })

    const { messageQueueConsumer, jobWorker } = testContext.diContainer.cradle

    expect(messageQueueConsumer.isStarted).toBe(true)
    expect(jobWorker.isStarted).toBe(false)

    await testContext.destroy()

    expect(messageQueueConsumer.isStarted).toBe(false)
    expect(jobWorker.isStarted).toBe(false)
  })

  it('does not resolve private dependency from a secondary module', async () => {
    const testContext = await testContextFactory.createTestContext({
      modules: [new TestModule()],
      secondaryModules: [new TestModuleSecondary()],
    })

    // @ts-expect-error private dependency
    expect(() => testContext.diContainer.cradle.testRepository).toThrowError(/Could not resolve/)
  })

  it('resolves public dependency from a secondary module', async () => {
    const testContext = await testContextFactory.createTestContext({
      modules: [new TestModule()],
      secondaryModules: [new TestModuleSecondary()],
    })

    const { testServiceWithTransitive } = testContext.diContainer.cradle

    await testServiceWithTransitive.execute()
  })
})
