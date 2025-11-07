import { AbstractModule, type MandatoryNameAndRegistrationPair } from '../lib/AbstractModule.js'
import type { DependencyInjectionOptions } from '../lib/DIContext.js'
import { asRepositoryClass, asServiceClass } from '../lib/resolverFunctions.js'

export class TestRepository {}

export class TestServiceSecondary {
  execute(): Promise<void> {
    return Promise.resolve()
  }
}

export type TestModuleSecondaryDependencies = {
  testServiceSecondary: TestServiceSecondary
  testRepository: TestRepository
}

export type TestModuleSecondaryPublicDependencies = Pick<
  TestModuleSecondaryDependencies,
  'testServiceSecondary'
>

export class TestModuleSecondary extends AbstractModule<TestModuleSecondaryDependencies> {
  resolveDependencies(
    _diOptions: DependencyInjectionOptions,
    _externalDependencies: never,
  ): MandatoryNameAndRegistrationPair<TestModuleSecondaryDependencies> {
    return {
      testServiceSecondary: asServiceClass(TestServiceSecondary),
      testRepository: asRepositoryClass(TestRepository),
    }
  }

  resolveControllers(): MandatoryNameAndRegistrationPair<unknown> {
    return {}
  }
}
