import { testContextFactory } from './ExampleTestContextFactory.js'
import { TestMessageQueueConsumer } from './TestModule.js'

describe('TestContext', () => {
  it('bootstraps given module', async () => {
    const testContext = await testContextFactory.createTestContext({
      diOptions: {
        messageQueueConsumersEnabled: [TestMessageQueueConsumer.QUEUE_ID],
        jobWorkersEnabled: false,
      },
    })

    const { messageQueueConsumer, jobWorker } = testContext.diContainer.cradle

    expect(messageQueueConsumer.isStarted).toBe(true)
    expect(jobWorker.isStarted).toBe(false)

    await testContext.destroy()

    expect(messageQueueConsumer.isStarted).toBe(false)
    expect(jobWorker.isStarted).toBe(false)
  })
})
