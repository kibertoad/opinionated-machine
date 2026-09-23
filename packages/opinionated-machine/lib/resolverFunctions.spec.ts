import { describe, expect, it } from 'vitest'
import { asEnqueuedJobWorkerClass, asMessageQueueHandlerClass } from './resolverFunctions.ts'

class Consumer {
  start() {
    return Promise.resolve()
  }
}

const diOptions = {}

describe('asMessageQueueHandlerClass', () => {
  it('starts consumers concurrently with the other inits of their priority', () => {
    const resolver = asMessageQueueHandlerClass(Consumer, { queueName: 'queue', diOptions })

    expect(resolver.asyncInit).toEqual({ method: 'start', concurrent: true })
  })

  it('lets the caller opt back into a sequential start', () => {
    const resolver = asMessageQueueHandlerClass(
      Consumer,
      { queueName: 'queue', diOptions },
      { asyncInit: 'start' },
    )

    expect(resolver.asyncInit).toBe('start')
  })
})

describe('asEnqueuedJobWorkerClass', () => {
  it('starts workers concurrently with the other inits of their priority', () => {
    const resolver = asEnqueuedJobWorkerClass(Consumer, { queueName: 'queue', diOptions })

    expect(resolver.asyncInit).toEqual({ method: 'start', concurrent: true })
  })

  it('lets the caller opt back into a sequential start', () => {
    const resolver = asEnqueuedJobWorkerClass(
      Consumer,
      { queueName: 'queue', diOptions },
      { asyncInit: 'start' },
    )

    expect(resolver.asyncInit).toBe('start')
  })
})
