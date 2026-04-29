import {
  AbstractModule,
  asSingletonClass,
  asSingletonFunction,
  type MandatoryNameAndRegistrationPair,
  SSERoomBroadcaster,
  SSERoomManager,
} from '../../../index.js'
import { asApiControllerClass } from '../../../lib/api-contracts/asApiControllerClass.ts'
import {
  TestApiController,
  TestApiErrorController,
  TestApiRoomController,
} from './testControllers.ts'

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

// ============================================================================
// Rooms module
// ============================================================================

export type TestApiRoomModuleDependencies = {
  sseRoomManager: SSERoomManager
  sseRoomBroadcaster: SSERoomBroadcaster
}

export type TestApiRoomModuleControllers = {
  testApiRoomController: TestApiRoomController
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

export class TestApiRoomModule extends AbstractModule<TestApiRoomModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<TestApiRoomModuleDependencies> {
    return {
      sseRoomManager: asSingletonFunction((): SSERoomManager => new SSERoomManager()),
      sseRoomBroadcaster: asSingletonClass(SSERoomBroadcaster),
    }
  }

  override resolveControllers(): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testApiRoomController: asApiControllerClass(TestApiRoomController),
    }
  }
}
