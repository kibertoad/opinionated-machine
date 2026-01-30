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
  TestLargeContentSSEController,
  TestLoggerSSEController,
  TestOpenAIStyleSSEController,
  TestPostSSEController,
  TestReconnectSSEController,
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
 * Module with logger test SSE controller for testing error handling in onDisconnect
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

  resolveControllers(): MandatoryNameAndRegistrationPair<unknown> {
    return {}
  }

  override resolveSSEControllers(): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testValidationSSEController: asSSEControllerClass(TestValidationSSEController),
    }
  }
}
