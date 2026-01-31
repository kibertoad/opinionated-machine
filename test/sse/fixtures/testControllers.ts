import {
  AbstractSSEController,
  type BuildFastifySSERoutesReturnType,
  buildHandler,
  type SSEConnection,
  type SSEControllerConfig,
  type SSELogger,
} from '../../../index.js'
import {
  asyncReconnectStreamContract,
  authenticatedStreamContract,
  channelStreamContract,
  chatCompletionContract,
  largeContentStreamContract,
  loggerTestStreamContract,
  notificationsStreamContract,
  onConnectErrorStreamContract,
  onReconnectErrorStreamContract,
  openaiStyleStreamContract,
  reconnectStreamContract,
  streamContract,
  validationTestStreamContract,
} from './testContracts.js'
import type { EventService, TestNotificationService } from './testServices.js'

/**
 * Simple SSE controller for integration tests
 */
export class StreamController extends AbstractSSEController<{
  stream: typeof streamContract
}> {
  public static contracts = { stream: streamContract } as const
  public connectionEvents: Array<{ type: string; connectionId: string }> = []

  private readonly eventService: EventService

  constructor(deps: { eventService: EventService }, sseConfig?: SSEControllerConfig) {
    super(deps, sseConfig)
    this.eventService = deps.eventService
  }

  buildSSERoutes(): BuildFastifySSERoutesReturnType<{ stream: typeof streamContract }> {
    return {
      stream: {
        contract: StreamController.contracts.stream,
        handlers: this.handleStream,
        options: {
          onConnect: (conn) => {
            this.connectionEvents.push({ type: 'connect', connectionId: conn.id })
          },
          onDisconnect: (conn) => {
            this.connectionEvents.push({ type: 'disconnect', connectionId: conn.id })
            this.eventService.unsubscribe(conn.id)
          },
        },
      },
    }
  }

  private handleStream = buildHandler(streamContract, {
    sse: (request, connection) => {
      const userId = request.query.userId ?? 'anonymous'
      connection.context = { userId }

      // Subscribe to events for this connection
      // Uses sendEventInternal for external event sources (subscriptions, timers, etc.)
      this.eventService.subscribe(connection.id, async (data) => {
        await this.sendEventInternal(connection.id, {
          event: 'message',
          data: { text: String(data) },
        })
      })
    },
  })

  // Testing helper - uses sendEventInternal which is public but @internal
  // Now properly typed to match the contract's message event schema
  pushToConnection(connectionId: string, data: { text: string }) {
    return this.sendEventInternal(connectionId, { event: 'message', data })
  }
}

/**
 * Test SSE controller for notifications
 */
export type TestSSEContracts = {
  notificationsStream: typeof notificationsStreamContract
}

export class TestSSEController extends AbstractSSEController<TestSSEContracts> {
  public static contracts = {
    notificationsStream: notificationsStreamContract,
  } as const

  readonly _notificationService: TestNotificationService

  // For testing: promise that handler waits for before completing
  private handlerDoneResolvers: Map<string, () => void> = new Map()

  constructor(
    deps: { notificationService: TestNotificationService },
    sseControllerConfig?: SSEControllerConfig,
  ) {
    super(deps, sseControllerConfig)
    this._notificationService = deps.notificationService
  }

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<TestSSEContracts> {
    return {
      notificationsStream: {
        contract: TestSSEController.contracts.notificationsStream,
        handlers: this.handleStream,
        options: {
          onConnect: this.onConnect,
          onDisconnect: this.onDisconnect,
        },
      },
    }
  }

  private handleStream = buildHandler(notificationsStreamContract, {
    sse: async (request, connection) => {
      const userId = request.query.userId ?? 'default'
      connection.context = { userId }

      // Wait for test to signal completion
      await new Promise<void>((resolve) => {
        this.handlerDoneResolvers.set(connection.id, resolve)
      })
    },
  })

  private onConnect = (_connection: SSEConnection) => {
    // Setup subscription when connected
  }

  private onDisconnect = (connection: SSEConnection) => {
    // Cleanup when disconnected
    // Resolve any pending handler resolver for this connection so completeHandler won't hang
    const resolve = this.handlerDoneResolvers.get(connection.id)
    if (resolve) {
      resolve()
      this.handlerDoneResolvers.delete(connection.id)
    }
  }

  /** Call this from tests to signal the handler can complete */
  public completeHandler(connectionId: string): void {
    const resolve = this.handlerDoneResolvers.get(connectionId)
    if (resolve) {
      resolve()
      this.handlerDoneResolvers.delete(connectionId)
    }
  }

  // Expose methods for testing - uses flexible typing for test convenience
  // In production code, use the typed send() parameter in handlers instead
  public testSendEvent(
    connectionId: string,
    message: { event?: string; data: unknown; id?: string },
  ) {
    return this._sendEventRaw(connectionId, message)
  }

  public testBroadcast(message: { event: string; data: unknown }) {
    return this.broadcast(message)
  }

  public testBroadcastIf(
    message: { event: string; data: unknown },
    predicate: (connection: SSEConnection) => boolean,
  ) {
    return this.broadcastIf(message, predicate)
  }

  public testGetConnectionCount() {
    return this.getConnectionCount()
  }

  public testGetConnections() {
    return this.getConnections()
  }

  public testCloseConnection(connectionId: string) {
    return this.closeConnection(connectionId)
  }
}

/**
 * Test SSE controller for POST requests (OpenAI-style)
 */
export type TestPostSSEContracts = {
  chatCompletion: typeof chatCompletionContract
}

export class TestPostSSEController extends AbstractSSEController<TestPostSSEContracts> {
  public static contracts = {
    chatCompletion: chatCompletionContract,
  } as const

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<TestPostSSEContracts> {
    return {
      chatCompletion: {
        contract: TestPostSSEController.contracts.chatCompletion,
        handlers: this.handleChatCompletion,
      },
    }
  }

  private handleChatCompletion = buildHandler(chatCompletionContract, {
    sse: async (request, connection) => {
      // Simulate streaming response
      const words = request.body.message.split(' ')
      for (const word of words) {
        await connection.send('chunk', { content: word })
      }
      await connection.send('done', { totalTokens: words.length })
      this.closeConnection(connection.id)
    },
  })
}

/**
 * Test SSE controller with preHandler authentication
 */
export type TestAuthSSEContracts = {
  authenticatedStream: typeof authenticatedStreamContract
}

export class TestAuthSSEController extends AbstractSSEController<TestAuthSSEContracts> {
  public static contracts = {
    authenticatedStream: authenticatedStreamContract,
  } as const

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<TestAuthSSEContracts> {
    return {
      authenticatedStream: {
        contract: TestAuthSSEController.contracts.authenticatedStream,
        handlers: this.handleAuthenticatedStream,
        options: {
          preHandler: (request, reply) => {
            const auth = request.headers.authorization
            if (!auth || !auth.startsWith('Bearer ')) {
              return Promise.resolve(reply.code(401).send({ error: 'Unauthorized' }))
            }
            return Promise.resolve()
          },
        },
      },
    }
  }

  private handleAuthenticatedStream = buildHandler(authenticatedStreamContract, {
    sse: async (_request, connection) => {
      await connection.send('data', { value: 'authenticated data' })
      this.closeConnection(connection.id)
    },
  })
}

/**
 * Test SSE controller with path params
 */
export type TestChannelSSEContracts = {
  channelStream: typeof channelStreamContract
}

export class TestChannelSSEController extends AbstractSSEController<TestChannelSSEContracts> {
  public static contracts = {
    channelStream: channelStreamContract,
  } as const

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<TestChannelSSEContracts> {
    return {
      channelStream: {
        contract: TestChannelSSEController.contracts.channelStream,
        handlers: this.handleChannelStream,
      },
    }
  }

  private handleChannelStream = buildHandler(channelStreamContract, {
    sse: async (request, connection) => {
      connection.context = { channelId: request.params.channelId }
      await connection.send('message', {
        id: '1',
        content: `Welcome to channel ${request.params.channelId}`,
        author: 'system',
      })
      this.closeConnection(connection.id)
    },
  })
}

/**
 * Test SSE controller with reconnection support (Last-Event-ID)
 */
export type TestReconnectSSEContracts = {
  reconnectStream: typeof reconnectStreamContract
}

export class TestReconnectSSEController extends AbstractSSEController<TestReconnectSSEContracts> {
  public static contracts = {
    reconnectStream: reconnectStreamContract,
  } as const

  // Simulated event storage for replay
  private eventHistory: Array<{ id: string; data: string }> = []

  constructor(deps: object, sseConfig?: SSEControllerConfig) {
    super(deps, sseConfig)
    // Pre-populate some events for replay testing
    this.eventHistory = [
      { id: '1', data: 'First event' },
      { id: '2', data: 'Second event' },
      { id: '3', data: 'Third event' },
      { id: '4', data: 'Fourth event' },
      { id: '5', data: 'Fifth event' },
    ]
  }

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<TestReconnectSSEContracts> {
    return {
      reconnectStream: {
        contract: TestReconnectSSEController.contracts.reconnectStream,
        handlers: this.handleReconnectStream,
        options: {
          onReconnect: this.handleReconnect,
        },
      },
    }
  }

  private handleReconnectStream = buildHandler(reconnectStreamContract, {
    sse: async (_request, connection) => {
      // Send a new event after connection
      await connection.send('event', { id: '6', data: 'New event after reconnect' }, { id: '6' })
      this.closeConnection(connection.id)
    },
  })

  private handleReconnect = (
    _connection: SSEConnection,
    lastEventId: string,
  ): Iterable<{ event?: string; data: { id: string; data: string }; id?: string }> => {
    // Find events after the lastEventId
    const lastIdNum = Number.parseInt(lastEventId, 10)
    const eventsToReplay = this.eventHistory.filter((e) => Number.parseInt(e.id, 10) > lastIdNum)

    // Return events to replay as an array (sync iterable)
    return eventsToReplay.map((event) => ({
      event: 'event',
      data: event,
      id: event.id,
    }))
  }

  // For testing: add an event to history
  public addEvent(id: string, data: string): void {
    this.eventHistory.push({ id, data })
  }
}

/**
 * Test SSE controller with async reconnection support (Last-Event-ID)
 */
export type TestAsyncReconnectSSEContracts = {
  asyncReconnectStream: typeof asyncReconnectStreamContract
}

export class TestAsyncReconnectSSEController extends AbstractSSEController<TestAsyncReconnectSSEContracts> {
  public static contracts = {
    asyncReconnectStream: asyncReconnectStreamContract,
  } as const

  // Simulated event storage for replay
  private eventHistory: Array<{ id: string; data: string }> = []

  constructor(deps: object, sseConfig?: SSEControllerConfig) {
    super(deps, sseConfig)
    // Pre-populate some events for replay testing
    this.eventHistory = [
      { id: '1', data: 'Async first event' },
      { id: '2', data: 'Async second event' },
      { id: '3', data: 'Async third event' },
    ]
  }

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<TestAsyncReconnectSSEContracts> {
    return {
      asyncReconnectStream: {
        contract: TestAsyncReconnectSSEController.contracts.asyncReconnectStream,
        handlers: this.handleReconnectStream,
        options: {
          onReconnect: this.handleReconnect,
        },
      },
    }
  }

  private handleReconnectStream = buildHandler(asyncReconnectStreamContract, {
    sse: async (_request, connection) => {
      // Send a new event after connection
      await connection.send(
        'event',
        { id: '4', data: 'Async new event after reconnect' },
        { id: '4' },
      )
      this.closeConnection(connection.id)
    },
  })

  // Async generator for replay - simulates fetching from database
  private handleReconnect = (
    _connection: SSEConnection,
    lastEventId: string,
  ): AsyncIterable<{ event?: string; data: { id: string; data: string }; id?: string }> => {
    const lastIdNum = Number.parseInt(lastEventId, 10)
    const eventsToReplay = this.eventHistory.filter((e) => Number.parseInt(e.id, 10) > lastIdNum)

    // Simulate async data source with an async generator
    async function* generateEvents() {
      for (const event of eventsToReplay) {
        // Simulate async delay (e.g., database fetch)
        await new Promise((resolve) => setTimeout(resolve, 1))
        yield {
          event: 'event',
          data: event,
          id: event.id,
        }
      }
    }

    return generateEvents()
  }
}

/**
 * Test SSE controller for large content streaming.
 * Verifies that closeConnection doesn't cut off data transfer.
 */
export type TestLargeContentSSEContracts = {
  largeContentStream: typeof largeContentStreamContract
}

export class TestLargeContentSSEController extends AbstractSSEController<TestLargeContentSSEContracts> {
  public static contracts = {
    largeContentStream: largeContentStreamContract,
  } as const

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<TestLargeContentSSEContracts> {
    return {
      largeContentStream: {
        contract: TestLargeContentSSEController.contracts.largeContentStream,
        handlers: this.handleLargeContentStream,
      },
    }
  }

  private handleLargeContentStream = buildHandler(largeContentStreamContract, {
    sse: async (request, connection) => {
      const { chunkCount, chunkSize } = request.body

      // Generate content of specified size (repeating pattern for easy verification)
      const generateContent = (index: number): string => {
        const pattern = `[chunk-${index}]`
        const repeatCount = Math.ceil(chunkSize / pattern.length)
        return pattern.repeat(repeatCount).slice(0, chunkSize)
      }

      let totalBytes = 0

      // Stream all chunks
      for (let i = 0; i < chunkCount; i++) {
        const content = generateContent(i)
        totalBytes += content.length
        await connection.send('chunk', { index: i, content })
      }

      // Send completion event with totals
      await connection.send('done', { totalChunks: chunkCount, totalBytes })

      this.closeConnection(connection.id)
    },
  })
}

/**
 * Test SSE controller for logger error handling.
 * The onDisconnect handler throws an error to test that:
 * 1. The logger is called with the error
 * 2. The connection is still properly unregistered despite the error
 */
export type TestLoggerSSEContracts = {
  loggerTestStream: typeof loggerTestStreamContract
}

export class TestLoggerSSEController extends AbstractSSEController<TestLoggerSSEContracts> {
  public static contracts = {
    loggerTestStream: loggerTestStreamContract,
  } as const

  private readonly logger: SSELogger

  constructor(deps: { logger: SSELogger }, sseConfig?: SSEControllerConfig) {
    super(deps, sseConfig)
    this.logger = deps.logger
  }

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<TestLoggerSSEContracts> {
    return {
      loggerTestStream: {
        contract: TestLoggerSSEController.contracts.loggerTestStream,
        handlers: this.handleStream,
        options: {
          logger: this.logger,
          onDisconnect: () => {
            // Intentionally throw to test error handling
            throw new Error('Test error in onDisconnect')
          },
        },
      },
    }
  }

  private handleStream = buildHandler(loggerTestStreamContract, {
    sse: async (_request, connection) => {
      await connection.send('message', { text: 'Hello from logger test' })
      // Don't close connection - let client close to trigger onDisconnect
    },
  })
}

/**
 * Test SSE controller for event validation testing.
 * Uses POST requests where the body contains the event data to send.
 * This allows end-to-end testing of validation by varying the request payload.
 *
 * The handler simply attempts to send the event - if validation fails,
 * the framework automatically sends an error event and closes the connection.
 */
export type TestValidationSSEContracts = {
  validationTestStream: typeof validationTestStreamContract
}

export class TestValidationSSEController extends AbstractSSEController<TestValidationSSEContracts> {
  public static contracts = {
    validationTestStream: validationTestStreamContract,
  } as const

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<TestValidationSSEContracts> {
    return {
      validationTestStream: {
        contract: TestValidationSSEController.contracts.validationTestStream,
        handlers: this.handleStream,
      },
    }
  }

  private handleStream = buildHandler(validationTestStreamContract, {
    sse: async (request, connection) => {
      // Send the event - if validation fails, error propagates to the framework
      // which sends an error event and closes the connection automatically
      // Cast to expected type since we're testing runtime validation with potentially invalid data
      // The body.eventData has loose typing (status: string) but event expects strict (status: enum)
      const eventData = request.body.eventData as {
        id: string
        count: number
        status: 'active' | 'inactive'
      }
      await connection.send('validatedEvent', eventData)
      this.closeConnection(connection.id)
    },
  })
}

/**
 * Test SSE controller for OpenAI-style streaming.
 * Demonstrates that JSON encoding is not mandatory - the stream can include
 * both JSON objects (for chunks) and plain strings (for the terminator).
 *
 * This replicates OpenAI's streaming behavior where:
 * 1. JSON chunks are streamed with content deltas
 * 2. The stream ends with a simple "[DONE]" string (not JSON encoded)
 */
export type TestOpenAIStyleSSEContracts = {
  openaiStyleStream: typeof openaiStyleStreamContract
}

export class TestOpenAIStyleSSEController extends AbstractSSEController<TestOpenAIStyleSSEContracts> {
  public static contracts = {
    openaiStyleStream: openaiStyleStreamContract,
  } as const

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<TestOpenAIStyleSSEContracts> {
    return {
      openaiStyleStream: {
        contract: TestOpenAIStyleSSEController.contracts.openaiStyleStream,
        handlers: this.handleOpenAIStyleStream,
      },
    }
  }

  private handleOpenAIStyleStream = buildHandler(openaiStyleStreamContract, {
    sse: async (request, connection) => {
      // Split prompt into words and stream each as a JSON chunk (like OpenAI)
      const words = request.body.prompt.split(' ')

      for (const word of words) {
        await connection.send('chunk', {
          choices: [
            {
              delta: {
                content: word,
              },
            },
          ],
        })
      }

      // Send the terminator as a plain string, exactly like OpenAI does
      // This demonstrates that JSON encoding is NOT mandatory for SSE data
      await connection.send('done', '[DONE]')

      this.closeConnection(connection.id)
    },
  })
}

/**
 * Test SSE controller for logger error handling in onReconnect.
 * The onReconnect handler throws an error to test that:
 * 1. The logger is called with the error
 * 2. The connection still works despite the error
 */
export type TestOnReconnectErrorSSEContracts = {
  onReconnectErrorStream: typeof onReconnectErrorStreamContract
}

export class TestOnReconnectErrorSSEController extends AbstractSSEController<TestOnReconnectErrorSSEContracts> {
  public static contracts = {
    onReconnectErrorStream: onReconnectErrorStreamContract,
  } as const

  private readonly logger: SSELogger

  constructor(deps: { logger: SSELogger }, sseConfig?: SSEControllerConfig) {
    super(deps, sseConfig)
    this.logger = deps.logger
  }

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<TestOnReconnectErrorSSEContracts> {
    return {
      onReconnectErrorStream: {
        contract: TestOnReconnectErrorSSEController.contracts.onReconnectErrorStream,
        handlers: this.handleStream,
        options: {
          logger: this.logger,
          onReconnect: () => {
            // Intentionally throw to test error handling
            throw new Error('Test error in onReconnect')
          },
        },
      },
    }
  }

  private handleStream = buildHandler(onReconnectErrorStreamContract, {
    sse: async (_request, connection) => {
      // Send message to verify connection still works after onReconnect error
      await connection.send('event', { id: 'new', data: 'Hello after onReconnect error' })
      this.closeConnection(connection.id)
    },
  })
}

/**
 * Test SSE controller for logger error handling in onConnect.
 * The onConnect handler throws an error to test that:
 * 1. The logger is called with the error
 * 2. The connection still works despite the error
 */
export type TestOnConnectErrorSSEContracts = {
  onConnectErrorStream: typeof onConnectErrorStreamContract
}

export class TestOnConnectErrorSSEController extends AbstractSSEController<TestOnConnectErrorSSEContracts> {
  public static contracts = {
    onConnectErrorStream: onConnectErrorStreamContract,
  } as const

  private readonly logger: SSELogger

  constructor(deps: { logger: SSELogger }, sseConfig?: SSEControllerConfig) {
    super(deps, sseConfig)
    this.logger = deps.logger
  }

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<TestOnConnectErrorSSEContracts> {
    return {
      onConnectErrorStream: {
        contract: TestOnConnectErrorSSEController.contracts.onConnectErrorStream,
        handlers: this.handleStream,
        options: {
          logger: this.logger,
          onConnect: () => {
            // Intentionally throw to test error handling
            throw new Error('Test error in onConnect')
          },
        },
      },
    }
  }

  private handleStream = buildHandler(onConnectErrorStreamContract, {
    sse: async (_request, connection) => {
      // Send message to verify connection still works after onConnect error
      await connection.send('message', { text: 'Hello after onConnect error' })
      this.closeConnection(connection.id)
    },
  })
}
