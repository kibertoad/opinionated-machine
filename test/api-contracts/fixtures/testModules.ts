import {
  AbstractModule,
  asSingletonClass,
  asSingletonFunction,
  type DependencyInjectionOptions,
  type MandatoryNameAndRegistrationPair,
  SSERoomBroadcaster,
  SSERoomManager,
} from '../../../index.js'
import { asApiControllerClass } from '../../../lib/api-contracts/asApiControllerClass.ts'
import { TestApiController, TestApiRoomController } from './testControllers.ts'

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

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testApiController: asApiControllerClass(TestApiController, { diOptions }),
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

export class TestApiRoomModule extends AbstractModule<TestApiRoomModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<TestApiRoomModuleDependencies> {
    return {
      sseRoomManager: asSingletonFunction((): SSERoomManager => new SSERoomManager()),
      sseRoomBroadcaster: asSingletonClass(SSERoomBroadcaster),
    }
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testApiRoomController: asApiControllerClass(TestApiRoomController, {
        diOptions,
        rooms: true,
      }),
    }
  }
}
