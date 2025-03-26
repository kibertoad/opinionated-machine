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

  it('services default to singleton', () => {
    const module = new TestModule()
    const container = createContainer({
      injectionMode: 'PROXY',
    })

    const context = new DIContext<TestModuleDependencies>(container, {})

    context.registerDependencies({
      modules: [module],
    })

    const testService = context.diContainer.cradle.testService
    testService.counter++

    const testService2 = context.diContainer.cradle.testService
    expect(testService2.counter).toBe(1)
  })

  it('service overrides default to singleton', () => {
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
    testService.counter++

    const testService2 = context.diContainer.cradle.testService
    expect(testService2.counter).toBe(1)
  })

  it('expendables default to transient', () => {
    const module = new TestModule()
    const container = createContainer({
      injectionMode: 'PROXY',
    })

    const context = new DIContext<TestModuleDependencies>(container, {})

    context.registerDependencies({
      modules: [module],
    })

    const testService = context.diContainer.cradle.testExpendable
    testService.counter++

    const testService2 = context.diContainer.cradle.testExpendable
    expect(testService2.counter).toBe(0)
  })

  it('expendables overrides default to transient', () => {
    const module = new TestModule()
    const container = createContainer({
      injectionMode: 'PROXY',
    })

    const context = new DIContext<TestModuleDependencies>(container, {})

    context.registerDependencies({
      modules: [module],
      dependencyOverrides: {
        testExpendable: asClass(TestService2, {
          entityType: 'expendable',
        }),
      },
    })

    const testService = context.diContainer.cradle.testExpendable
    testService.counter++

    const testService2 = context.diContainer.cradle.testExpendable
    expect(testService2.counter).toBe(0)
  })
})
