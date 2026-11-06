import { describe, expect, it } from 'vitest'
import { asEnqueuedJobWorkerClass, asMessageQueueHandlerClass } from './resolverFunctions.ts'

class Lifecycle {
  start() {
    return Promise.resolve()
  }
}

const diOptions = {}

describe.each([
  [asMessageQueueHandlerClass, 'close'],
  [asEnqueuedJobWorkerClass, 'dispose'],
] as const)('%o', (helper, disposeMethod) => {
  it('starts concurrently with the other inits of its priority', () => {
    const resolver = helper(Lifecycle, { queueName: 'queue', diOptions })

    expect(resolver.asyncInit).toEqual({ method: 'start', concurrent: true })
  })

  it('lets the caller opt back into a sequential start', () => {
    const resolver = helper(Lifecycle, { queueName: 'queue', diOptions }, { asyncInit: 'start' })

    expect(resolver.asyncInit).toBe('start')
  })

  it('disposes concurrently with the other disposes of its priority', () => {
    const resolver = helper(Lifecycle, { queueName: 'queue', diOptions })

    expect(resolver.asyncDispose).toEqual({ method: disposeMethod, concurrent: true })
  })

  it('lets the caller opt back into a sequential dispose', () => {
    const resolver = helper(
      Lifecycle,
      { queueName: 'queue', diOptions },
      { asyncDispose: disposeMethod },
    )

    expect(resolver.asyncDispose).toBe(disposeMethod)
  })
})
