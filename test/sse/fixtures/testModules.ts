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
  streamController: StreamController
}

export class StreamModule extends AbstractModule<StreamModuleDependencies> {
  resolveDependencies(
    _diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<StreamModuleDependencies> {
    return {
      eventService: asServiceClass(EventService),
      streamController: asSSEControllerClass(StreamController),
    }
  }

  resolveControllers(): MandatoryNameAndRegistrationPair<unknown> {
    return {}
  }

  override resolveSSEControllers(): MandatoryNameAndRegistrationPair<unknown> {
    return {
      streamController: asSSEControllerClass(StreamController),
    }
  }
}

/**
 * Module with SSE controller for notifications
 */
export type TestSSEModuleDependencies = {
  notificationService: TestNotificationService
  testSSEController: TestSSEController
}

export class TestSSEModule extends AbstractModule<TestSSEModuleDependencies> {
  resolveDependencies(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<TestSSEModuleDependencies> {
    return {
      notificationService: asServiceClass(TestNotificationService),
      testSSEController: asSSEControllerClass(TestSSEController, { diOptions }),
    }
  }

  resolveControllers(): MandatoryNameAndRegistrationPair<unknown> {
    return {}
  }

  override resolveSSEControllers(): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testSSEController: asSSEControllerClass(TestSSEController),
    }
  }
}

/**
 * Module with POST SSE controllers (OpenAI-style and large content streaming)
 */
export type TestPostSSEModuleDependencies = {
  testPostSSEController: TestPostSSEController
  testLargeContentSSEController: TestLargeContentSSEController
}

export class TestPostSSEModule extends AbstractModule<TestPostSSEModuleDependencies> {
  resolveDependencies(
    _diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<TestPostSSEModuleDependencies> {
    return {
      testPostSSEController: asSSEControllerClass(TestPostSSEController),
      testLargeContentSSEController: asSSEControllerClass(TestLargeContentSSEController),
    }
  }

  resolveControllers(): MandatoryNameAndRegistrationPair<unknown> {
    return {}
  }

  override resolveSSEControllers(): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testPostSSEController: asSSEControllerClass(TestPostSSEController),
      testLargeContentSSEController: asSSEControllerClass(TestLargeContentSSEController),
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

  resolveControllers(): MandatoryNameAndRegistrationPair<unknown> {
    return {}
  }

  // Uses default resolveSSEControllers() which returns {}
}

/**
 * Module with authenticated SSE controller
 */
export type TestAuthSSEModuleDependencies = {
  testAuthSSEController: TestAuthSSEController
}

export class TestAuthSSEModule extends AbstractModule<TestAuthSSEModuleDependencies> {
  resolveDependencies(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<TestAuthSSEModuleDependencies> {
    return {
      testAuthSSEController: asSSEControllerClass(TestAuthSSEController, { diOptions }),
    }
  }

  resolveControllers(): MandatoryNameAndRegistrationPair<unknown> {
    return {}
  }

  override resolveSSEControllers(): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testAuthSSEController: asSSEControllerClass(TestAuthSSEController),
    }
  }
}

/**
 * Module with channel SSE controller (path params)
 */
export type TestChannelSSEModuleDependencies = {
  testChannelSSEController: TestChannelSSEController
}

export class TestChannelSSEModule extends AbstractModule<TestChannelSSEModuleDependencies> {
  resolveDependencies(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<TestChannelSSEModuleDependencies> {
    return {
      testChannelSSEController: asSSEControllerClass(TestChannelSSEController, { diOptions }),
    }
  }

  resolveControllers(): MandatoryNameAndRegistrationPair<unknown> {
    return {}
  }

  override resolveSSEControllers(): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testChannelSSEController: asSSEControllerClass(TestChannelSSEController),
    }
  }
}

/**
 * Module with reconnect SSE controllers (Last-Event-ID, both sync and async replay)
 */
export type TestReconnectSSEModuleDependencies = {
  testReconnectSSEController: TestReconnectSSEController
  testAsyncReconnectSSEController: TestAsyncReconnectSSEController
}

export class TestReconnectSSEModule extends AbstractModule<TestReconnectSSEModuleDependencies> {
  resolveDependencies(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<TestReconnectSSEModuleDependencies> {
    return {
      testReconnectSSEController: asSSEControllerClass(TestReconnectSSEController, { diOptions }),
      testAsyncReconnectSSEController: asSSEControllerClass(TestAsyncReconnectSSEController, {
        diOptions,
      }),
    }
  }

  resolveControllers(): MandatoryNameAndRegistrationPair<unknown> {
    return {}
  }

  override resolveSSEControllers(): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testReconnectSSEController: asSSEControllerClass(TestReconnectSSEController),
      testAsyncReconnectSSEController: asSSEControllerClass(TestAsyncReconnectSSEController),
    }
  }
}

/**
 * Module with logger test SSE controller for testing error handling in onDisconnect
 */
export type TestLoggerSSEModuleDependencies = {
  logger: SSELogger
  testLoggerSSEController: TestLoggerSSEController
}

export class TestLoggerSSEModule extends AbstractModule<TestLoggerSSEModuleDependencies> {
  private mockLogger: SSELogger

  constructor(mockLogger: SSELogger) {
    super()
    this.mockLogger = mockLogger
  }

  resolveDependencies(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<TestLoggerSSEModuleDependencies> {
    const logger = this.mockLogger
    return {
      logger: asSingletonFunction(() => logger),
      testLoggerSSEController: asSSEControllerClass(TestLoggerSSEController, { diOptions }),
    }
  }

  resolveControllers(): MandatoryNameAndRegistrationPair<unknown> {
    return {}
  }

  override resolveSSEControllers(): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testLoggerSSEController: asSSEControllerClass(TestLoggerSSEController),
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
