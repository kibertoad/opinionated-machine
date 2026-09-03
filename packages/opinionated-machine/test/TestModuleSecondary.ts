import {
  AbstractModule,
  type InferModuleDependencies,
  type InferPublicModuleDependencies,
  type MandatoryNameAndRegistrationPair,
} from '../lib/AbstractModule.js'
import type { DependencyInjectionOptions } from '../lib/DIContext.js'
import { asRepositoryClass, asServiceClass } from '../lib/resolverFunctions.js'

export class TestRepository {}

export class TestServiceSecondary {
  execute(): Promise<void> {
    return Promise.resolve()
  }
}

export class TestModuleSecondary extends AbstractModule {
  resolveDependencies(_diOptions: DependencyInjectionOptions) {
    return {
      testServiceSecondary: asServiceClass(TestServiceSecondary),
      testRepository: asRepositoryClass(TestRepository),
    }
  }

  override resolveControllers(
    _diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {}
  }
}

export type TestModuleSecondaryDependencies = InferModuleDependencies<TestModuleSecondary>

export type TestModuleSecondaryPublicDependencies =
  InferPublicModuleDependencies<TestModuleSecondary>
