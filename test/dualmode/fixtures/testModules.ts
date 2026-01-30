import {
  AbstractModule,
  asDualModeControllerClass,
  type DependencyInjectionOptions,
  type MandatoryNameAndRegistrationPair,
} from '../../../index.js'
import {
  TestAuthenticatedDualModeController,
  TestChatDualModeController,
  TestConversationDualModeController,
  TestDefaultModeDualModeController,
  TestJobStatusDualModeController,
} from './testControllers.js'

/**
 * Module with basic chat dual-mode controller.
 */
export type TestChatDualModeModuleDependencies = Record<string, never>

export class TestChatDualModeModule extends AbstractModule<TestChatDualModeModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<TestChatDualModeModuleDependencies> {
    return {}
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testChatDualModeController: asDualModeControllerClass(TestChatDualModeController, {
        diOptions,
      }),
    }
  }
}

/**
 * Module with conversation dual-mode controller (path params + auth).
 */
export type TestConversationDualModeModuleDependencies = Record<string, never>

export class TestConversationDualModeModule extends AbstractModule<TestConversationDualModeModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<TestConversationDualModeModuleDependencies> {
    return {}
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testConversationDualModeController: asDualModeControllerClass(
        TestConversationDualModeController,
        { diOptions },
      ),
    }
  }
}

/**
 * Module with job status dual-mode controller (GET method).
 */
export type TestJobStatusDualModeModuleDependencies = Record<string, never>

export class TestJobStatusDualModeModule extends AbstractModule<TestJobStatusDualModeModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<TestJobStatusDualModeModuleDependencies> {
    return {}
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testJobStatusDualModeController: asDualModeControllerClass(TestJobStatusDualModeController, {
        diOptions,
      }),
    }
  }
}

/**
 * Module with authenticated dual-mode controller.
 */
export type TestAuthenticatedDualModeModuleDependencies = Record<string, never>

export class TestAuthenticatedDualModeModule extends AbstractModule<TestAuthenticatedDualModeModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<TestAuthenticatedDualModeModuleDependencies> {
    return {}
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testAuthenticatedDualModeController: asDualModeControllerClass(
        TestAuthenticatedDualModeController,
        { diOptions },
      ),
    }
  }
}

/**
 * Module with default mode test dual-mode controller.
 */
export type TestDefaultModeDualModeModuleDependencies = Record<string, never>

export class TestDefaultModeDualModeModule extends AbstractModule<TestDefaultModeDualModeModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<TestDefaultModeDualModeModuleDependencies> {
    return {}
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testDefaultModeDualModeController: asDualModeControllerClass(
        TestDefaultModeDualModeController,
        { diOptions },
      ),
    }
  }
}
