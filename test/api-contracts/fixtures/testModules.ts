import { AbstractModule, type MandatoryNameAndRegistrationPair } from '../../../index.js'
import { asApiControllerClass } from '../../../lib/api-contracts/asApiControllerClass.ts'
import { TestApiController, TestApiErrorController } from './testControllers.ts'

// ============================================================================
// Non-SSE + dual-mode module
// ============================================================================

export type TestApiModuleControllers = {
  testApiController: TestApiController
}

export class TestApiModule extends AbstractModule<object> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<object> {
    return {}
  }

  override resolveControllers(): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testApiController: asApiControllerClass(TestApiController),
    }
  }
}

export type TestApiErrorModuleControllers = {
  testApiErrorController: TestApiErrorController
}

export class TestApiErrorModule extends AbstractModule<object> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<object> {
    return {}
  }

  override resolveControllers(): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testApiErrorController: asApiControllerClass(TestApiErrorController),
    }
  }
}
