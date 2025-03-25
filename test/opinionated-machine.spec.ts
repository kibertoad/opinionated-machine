import { asClass, createContainer } from 'awilix'
import { describe, it } from 'vitest'
import { DIContext } from '../lib/DIContext.js'
import { TestModule, type TestModuleDependencies, TestService, TestService2 } from './TestModule.js'

describe('opinionated-machine', () => {
  it('injects service from a module', () => {
    const module = new TestModule()
    const container = createContainer({
      injectionMode: 'PROXY',
    })

    const context = new DIContext<TestModuleDependencies>(container, {})

    context.registerDependencies({
      modules: [module],
    })

    const testService = context.diContainer.cradle.testService
    expect(testService).toBeInstanceOf(TestService)
  })

  it('injects service override from a module', () => {
    const module = new TestModule()
    const container = createContainer({
      injectionMode: 'PROXY',
    })

    const context = new DIContext<TestModuleDependencies>(container, {})

    context.registerDependencies({
      modules: [module],
      dependencyOverrides: {
        testService: asClass(TestService2),
      },
    })

    const testService = context.diContainer.cradle.testService
    expect(testService).toBeInstanceOf(TestService2)
  })
})
