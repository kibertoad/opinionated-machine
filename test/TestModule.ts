import { asClass } from 'awilix'
import { AbstractModule, type MandatoryNameAndRegistrationPair } from '../lib/AbstractModule.js'
import type { DependencyInjectionOptions } from '../lib/DIContext.js'
import { TestController } from './TestController.js'

export type TestModuleDependencies = {
  testService: TestService
  testExpendable: TestService
  testController: TestController
}

export class TestService {
  public counter = 0
}

export class TestService2 extends TestService {}

export class TestModule extends AbstractModule<TestModuleDependencies> {
  resolveDIConfig(
    _options: DependencyInjectionOptions | undefined,
  ): MandatoryNameAndRegistrationPair<TestModuleDependencies> {
    return {
      testService: asClass(TestService, {
        entityType: 'service',
      }),

      testExpendable: asClass(TestService, {
        entityType: 'expendable',
      }),

      testController: asClass(TestController, {
        entityType: 'controller',
      }),
    }
  }
}
