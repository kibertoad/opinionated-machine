import { AbstractModule, type MandatoryNameAndRegistrationPair } from '../lib/AbstractModule.ts'
import type { DependencyInjectionOptions } from '../lib/DIContext.ts'
import { asRepositoryClass, asServiceClass } from '../lib/resolverFunctions.ts'

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
