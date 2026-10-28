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

  it('closes consumers concurrently with the other disposes of their priority', () => {
    const resolver = asMessageQueueHandlerClass(Consumer, { queueName: 'queue', diOptions })

    expect(resolver.asyncDispose).toEqual({ method: 'close', concurrent: true })
  })

  it('lets the caller opt back into a sequential dispose', () => {
    const resolver = asMessageQueueHandlerClass(
      Consumer,
      { queueName: 'queue', diOptions },
      { asyncDispose: 'close' },
    )

    expect(resolver.asyncDispose).toBe('close')
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

  it('disposes workers concurrently with the other disposes of their priority', () => {
    const resolver = asEnqueuedJobWorkerClass(Consumer, { queueName: 'queue', diOptions })

    expect(resolver.asyncDispose).toEqual({ method: 'dispose', concurrent: true })
  })

  it('lets the caller opt back into a sequential dispose', () => {
    const resolver = asEnqueuedJobWorkerClass(
      Consumer,
      { queueName: 'queue', diOptions },
      { asyncDispose: 'dispose' },
    )

    expect(resolver.asyncDispose).toBe('dispose')
  })
})
