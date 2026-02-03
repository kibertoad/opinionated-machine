import {
  AbstractModule,
  asDualModeControllerClass,
  type DependencyInjectionOptions,
  type MandatoryNameAndRegistrationPair,
} from '../../../index.js'
import {
  GenericDualModeController,
  TestAuthenticatedDualModeController,
  TestChatDualModeController,
  TestConversationDualModeController,
  TestDefaultMethodDualModeController,
  TestDefaultModeDualModeController,
  TestErrorDualModeController,
  TestJobStatusDualModeController,
  TestJsonValidationDualModeController,
  TestMultiFormatExportController,
  TestMultiFormatReportController,
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

/**
 * Module with error test dual-mode controller.
 */
export type TestErrorDualModeModuleDependencies = Record<string, never>

export class TestErrorDualModeModule extends AbstractModule<TestErrorDualModeModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<TestErrorDualModeModuleDependencies> {
    return {}
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testErrorDualModeController: asDualModeControllerClass(TestErrorDualModeController, {
        diOptions,
      }),
    }
  }
}

/**
 * Module with default method test dual-mode controller.
 * Tests the case where method is not specified in buildContract (with body).
 */
export type TestDefaultMethodDualModeModuleDependencies = Record<string, never>

export class TestDefaultMethodDualModeModule extends AbstractModule<TestDefaultMethodDualModeModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<TestDefaultMethodDualModeModuleDependencies> {
    return {}
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testDefaultMethodDualModeController: asDualModeControllerClass(
        TestDefaultMethodDualModeController,
        { diOptions },
      ),
    }
  }
}

/**
 * Module with JSON validation test dual-mode controller.
 * Tests JSON response validation failure.
 */
export type TestJsonValidationDualModeModuleDependencies = Record<string, never>

export class TestJsonValidationDualModeModule extends AbstractModule<TestJsonValidationDualModeModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<TestJsonValidationDualModeModuleDependencies> {
    return {}
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testJsonValidationDualModeController: asDualModeControllerClass(
        TestJsonValidationDualModeController,
        { diOptions },
      ),
    }
  }
}

/**
 * Module with generic dual-mode controller for ad-hoc contract testing.
 */
export type GenericDualModeModuleDependencies = Record<string, never>

export class GenericDualModeModule extends AbstractModule<GenericDualModeModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<GenericDualModeModuleDependencies> {
    return {}
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      genericDualModeController: asDualModeControllerClass(GenericDualModeController, {
        diOptions,
      }),
    }
  }
}

/**
 * Module with multi-format export controller.
 */
export type TestMultiFormatExportModuleDependencies = Record<string, never>

export class TestMultiFormatExportModule extends AbstractModule<TestMultiFormatExportModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<TestMultiFormatExportModuleDependencies> {
    return {}
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testMultiFormatExportController: asDualModeControllerClass(TestMultiFormatExportController, {
        diOptions,
      }),
    }
  }
}

/**
 * Module with multi-format report controller.
 */
export type TestMultiFormatReportModuleDependencies = Record<string, never>

export class TestMultiFormatReportModule extends AbstractModule<TestMultiFormatReportModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<TestMultiFormatReportModuleDependencies> {
    return {}
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testMultiFormatReportController: asDualModeControllerClass(TestMultiFormatReportController, {
        diOptions,
      }),
    }
  }
}
