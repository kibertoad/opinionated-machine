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
