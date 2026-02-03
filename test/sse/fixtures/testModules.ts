import {
  AbstractModule,
  asServiceClass,
  asSingletonFunction,
  asSSEControllerClass,
  type DependencyInjectionOptions,
  type MandatoryNameAndRegistrationPair,
  type SSELogger,
} from '../../../index.js'
import {
  StreamController,
  TestAsyncReconnectSSEController,
  TestAuthSSEController,
  TestChannelSSEController,
  TestDeferredHeaders404Controller,
  TestDeferredHeaders422Controller,
  TestErrorAfterStartController,
  TestForgottenStartController,
  TestGetStreamSSEController,
  TestIsConnectedSSEController,
  TestLargeContentSSEController,
  TestLoggerSSEController,
  TestOnCloseErrorSSEController,
  TestOnConnectErrorSSEController,
  TestOnReconnectErrorSSEController,
  TestOpenAIStyleSSEController,
  TestPostSSEController,
  TestReconnectSSEController,
  TestSendStreamSSEController,
  TestSSEController,
  TestValidationSSEController,
} from './testControllers.js'
import { EventService, TestNotificationService } from './testServices.js'

/**
 * Module with simple stream controller for integration tests
 */
export type StreamModuleDependencies = {
  eventService: EventService
}

export class StreamModule extends AbstractModule<StreamModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<StreamModuleDependencies> {
    return {
      eventService: asServiceClass(EventService),
    }
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      streamController: asSSEControllerClass(StreamController, { diOptions }),
    }
  }
}

/**
 * Module with SSE controller for notifications
 */
export type TestSSEModuleDependencies = {
  notificationService: TestNotificationService
}

// Controllers are registered via resolveControllers(), available in DI container
export type TestSSEModuleControllers = {
  testSSEController: TestSSEController
}

export class TestSSEModule extends AbstractModule<TestSSEModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<TestSSEModuleDependencies> {
    return {
      notificationService: asServiceClass(TestNotificationService),
    }
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testSSEController: asSSEControllerClass(TestSSEController, { diOptions }),
    }
  }
}

/**
 * Module with POST SSE controllers (OpenAI-style and large content streaming)
 */
export type TestPostSSEModuleDependencies = Record<string, never>

export class TestPostSSEModule extends AbstractModule<TestPostSSEModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<TestPostSSEModuleDependencies> {
    return {}
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testPostSSEController: asSSEControllerClass(TestPostSSEController, { diOptions }),
      testLargeContentSSEController: asSSEControllerClass(TestLargeContentSSEController, {
        diOptions,
      }),
    }
  }
}

/**
 * Module without any SSE controllers
 */
export type NoSSEModuleDependencies = {
  notificationService: TestNotificationService
}

export class NoSSEModule extends AbstractModule<NoSSEModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<NoSSEModuleDependencies> {
    return {
      notificationService: asServiceClass(TestNotificationService),
    }
  }

  // Uses default resolveControllers() which returns {}
}

/**
 * Module with authenticated SSE controller
 */
export type TestAuthSSEModuleDependencies = Record<string, never>

export class TestAuthSSEModule extends AbstractModule<TestAuthSSEModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<TestAuthSSEModuleDependencies> {
    return {}
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testAuthSSEController: asSSEControllerClass(TestAuthSSEController, { diOptions }),
    }
  }
}

/**
 * Module with channel SSE controller (path params)
 */
export type TestChannelSSEModuleDependencies = Record<string, never>

export class TestChannelSSEModule extends AbstractModule<TestChannelSSEModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<TestChannelSSEModuleDependencies> {
    return {}
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testChannelSSEController: asSSEControllerClass(TestChannelSSEController, { diOptions }),
    }
  }
}

/**
 * Module with reconnect SSE controllers (Last-Event-ID, both sync and async replay)
 */
export type TestReconnectSSEModuleDependencies = Record<string, never>

export class TestReconnectSSEModule extends AbstractModule<TestReconnectSSEModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<TestReconnectSSEModuleDependencies> {
    return {}
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testReconnectSSEController: asSSEControllerClass(TestReconnectSSEController, { diOptions }),
      testAsyncReconnectSSEController: asSSEControllerClass(TestAsyncReconnectSSEController, {
        diOptions,
      }),
    }
  }
}

/**
 * Module with logger test SSE controller for testing error handling in onClose
 */
export type TestLoggerSSEModuleDependencies = {
  logger: SSELogger
}

export class TestLoggerSSEModule extends AbstractModule<TestLoggerSSEModuleDependencies> {
  private mockLogger: SSELogger

  constructor(mockLogger: SSELogger) {
    super()
    this.mockLogger = mockLogger
  }

  resolveDependencies(): MandatoryNameAndRegistrationPair<TestLoggerSSEModuleDependencies> {
    const logger = this.mockLogger
    return {
      logger: asSingletonFunction(() => logger),
    }
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testLoggerSSEController: asSSEControllerClass(TestLoggerSSEController, { diOptions }),
    }
  }
}

/**
 * Module with onConnect error test SSE controller for testing error handling in onConnect
 */
export type TestOnConnectErrorSSEModuleDependencies = {
  logger: SSELogger
}

export class TestOnConnectErrorSSEModule extends AbstractModule<TestOnConnectErrorSSEModuleDependencies> {
  private mockLogger: SSELogger

  constructor(mockLogger: SSELogger) {
    super()
    this.mockLogger = mockLogger
  }

  resolveDependencies(): MandatoryNameAndRegistrationPair<TestOnConnectErrorSSEModuleDependencies> {
    const logger = this.mockLogger
    return {
      logger: asSingletonFunction(() => logger),
    }
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testOnConnectErrorSSEController: asSSEControllerClass(TestOnConnectErrorSSEController, {
        diOptions,
      }),
    }
  }
}

/**
 * Module with onReconnect error test SSE controller for testing error handling in onReconnect
 */
export type TestOnReconnectErrorSSEModuleDependencies = {
  logger: SSELogger
}

export class TestOnReconnectErrorSSEModule extends AbstractModule<TestOnReconnectErrorSSEModuleDependencies> {
  private mockLogger: SSELogger

  constructor(mockLogger: SSELogger) {
    super()
    this.mockLogger = mockLogger
  }

  resolveDependencies(): MandatoryNameAndRegistrationPair<TestOnReconnectErrorSSEModuleDependencies> {
    const logger = this.mockLogger
    return {
      logger: asSingletonFunction(() => logger),
    }
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testOnReconnectErrorSSEController: asSSEControllerClass(TestOnReconnectErrorSSEController, {
        diOptions,
      }),
    }
  }
}

/**
 * Module with OpenAI-style SSE controller for testing string terminators
 */
export type TestOpenAIStyleSSEModuleDependencies = Record<string, never>

export class TestOpenAIStyleSSEModule extends AbstractModule<TestOpenAIStyleSSEModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<TestOpenAIStyleSSEModuleDependencies> {
    return {}
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testOpenAIStyleSSEController: asSSEControllerClass(TestOpenAIStyleSSEController, {
        diOptions,
      }),
    }
  }
}

/**
 * Module with validation test SSE controller for testing event validation
 */
export type TestValidationSSEModuleDependencies = {
  testValidationSSEController: TestValidationSSEController
}

export class TestValidationSSEModule extends AbstractModule<TestValidationSSEModuleDependencies> {
  resolveDependencies(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<TestValidationSSEModuleDependencies> {
    return {
      testValidationSSEController: asSSEControllerClass(TestValidationSSEController, { diOptions }),
    }
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testValidationSSEController: asSSEControllerClass(TestValidationSSEController, { diOptions }),
    }
  }
}

/**
 * Module with onClose error test SSE controller for testing error handling in onClose
 */
export type TestOnCloseErrorSSEModuleDependencies = {
  logger: SSELogger
}

export class TestOnCloseErrorSSEModule extends AbstractModule<TestOnCloseErrorSSEModuleDependencies> {
  private mockLogger: SSELogger

  constructor(mockLogger: SSELogger) {
    super()
    this.mockLogger = mockLogger
  }

  resolveDependencies(): MandatoryNameAndRegistrationPair<TestOnCloseErrorSSEModuleDependencies> {
    const logger = this.mockLogger
    return {
      logger: asSingletonFunction(() => logger),
    }
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testOnCloseErrorSSEController: asSSEControllerClass(TestOnCloseErrorSSEController, {
        diOptions,
      }),
    }
  }
}

/**
 * Module with isConnected test SSE controller
 */
export type TestIsConnectedSSEModuleDependencies = Record<string, never>

export class TestIsConnectedSSEModule extends AbstractModule<TestIsConnectedSSEModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<TestIsConnectedSSEModuleDependencies> {
    return {}
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testIsConnectedSSEController: asSSEControllerClass(TestIsConnectedSSEController, {
        diOptions,
      }),
    }
  }
}

/**
 * Module with sendStream test SSE controller
 */
export type TestSendStreamSSEModuleDependencies = Record<string, never>

export class TestSendStreamSSEModule extends AbstractModule<TestSendStreamSSEModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<TestSendStreamSSEModuleDependencies> {
    return {}
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testSendStreamSSEController: asSSEControllerClass(TestSendStreamSSEController, {
        diOptions,
      }),
    }
  }
}

/**
 * Module with getStream test SSE controller
 */
export type TestGetStreamSSEModuleDependencies = Record<string, never>

export class TestGetStreamSSEModule extends AbstractModule<TestGetStreamSSEModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<TestGetStreamSSEModuleDependencies> {
    return {}
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testGetStreamSSEController: asSSEControllerClass(TestGetStreamSSEController, {
        diOptions,
      }),
    }
  }
}

// ============================================================================
// Deferred Headers Test Modules
// ============================================================================

/**
 * Module with deferred headers 404 test controller
 */
export type TestDeferredHeaders404ModuleDependencies = Record<string, never>

export class TestDeferredHeaders404Module extends AbstractModule<TestDeferredHeaders404ModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<TestDeferredHeaders404ModuleDependencies> {
    return {}
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testDeferredHeaders404Controller: asSSEControllerClass(TestDeferredHeaders404Controller, {
        diOptions,
      }),
    }
  }
}

/**
 * Module with deferred headers 422 test controller
 */
export type TestDeferredHeaders422ModuleDependencies = Record<string, never>

export class TestDeferredHeaders422Module extends AbstractModule<TestDeferredHeaders422ModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<TestDeferredHeaders422ModuleDependencies> {
    return {}
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testDeferredHeaders422Controller: asSSEControllerClass(TestDeferredHeaders422Controller, {
        diOptions,
      }),
    }
  }
}

/**
 * Module with forgotten start test controller
 */
export type TestForgottenStartModuleDependencies = Record<string, never>

export class TestForgottenStartModule extends AbstractModule<TestForgottenStartModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<TestForgottenStartModuleDependencies> {
    return {}
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testForgottenStartController: asSSEControllerClass(TestForgottenStartController, {
        diOptions,
      }),
    }
  }
}

/**
 * Module with error after start test controller
 */
export type TestErrorAfterStartModuleDependencies = Record<string, never>

export class TestErrorAfterStartModule extends AbstractModule<TestErrorAfterStartModuleDependencies> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<TestErrorAfterStartModuleDependencies> {
    return {}
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testErrorAfterStartController: asSSEControllerClass(TestErrorAfterStartController, {
        diOptions,
      }),
    }
  }
}
