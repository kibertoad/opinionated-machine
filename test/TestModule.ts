import { asClass } from 'awilix'
import { AbstractModule, type MandatoryNameAndRegistrationPair } from '../lib/AbstractModule.js'
import { type DependencyInjectionOptions, SINGLETON_CONFIG } from '../lib/DIContext.js'

export type TestModuleDependencies = {
  testService: TestService
}

export class TestService {}

export class TestService2 extends TestService {}

export class TestModule extends AbstractModule<TestModuleDependencies> {
  resolveDIConfig(
    _options: DependencyInjectionOptions | undefined,
  ): MandatoryNameAndRegistrationPair<TestModuleDependencies> {
    return {
      testService: asClass(TestService, SINGLETON_CONFIG),
    }
  }
}
