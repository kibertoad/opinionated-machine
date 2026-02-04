import { PublicNonRecoverableError } from '@lokalise/node-core'
import {
  AbstractSSEController,
  type BuildFastifySSERoutesReturnType,
  buildHandler,
  type SSECloseReason,
  type SSEControllerConfig,
  type SSEHandlerResult,
  type SSELogger,
  type SSESession,
} from '../../../index.js'
import {
  asyncReconnectStreamContract,
  authenticatedStreamContract,
  channelStreamContract,
  chatCompletionContract,
  deferredHeaders404Contract,
  deferredHeaders422Contract,
  errorAfterStartContract,
  forgottenStartContract,
  getStreamTestContract,
  isConnectedTestStreamContract,
  largeContentStreamContract,
  loggerTestStreamContract,
  nonErrorThrowContract,
  notificationsStreamContract,
  onCloseErrorStreamContract,
  onConnectErrorStreamContract,
  onReconnectErrorStreamContract,
  openaiStyleStreamContract,
  publicErrorContract,
  reconnectStreamContract,
  respondWithoutReturnContract,
  roomStreamContract,
  sendStreamTestContract,
  sseRespondValidationContract,
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
      stream: this.handleStream,
    }
  }

  private handleStream = buildHandler(
    streamContract,
    {
      sse: (request, sse) => {
        const userId = request.query.userId ?? 'anonymous'
        const connection = sse.start('keepAlive', { context: { userId } })

        // Subscribe to events for this connection
        // Uses sendEventInternal for external event sources (subscriptions, timers, etc.)
        this.eventService.subscribe(connection.id, async (data) => {
          await this.sendEventInternal(connection.id, {
            event: 'message',
            data: { text: String(data) },
          })
        })
      },
    },
    {
      onConnect: (conn) => {
        this.connectionEvents.push({ type: 'connect', connectionId: conn.id })
      },
      onClose: (conn) => {
        this.connectionEvents.push({ type: 'disconnect', connectionId: conn.id })
        this.eventService.unsubscribe(conn.id)
      },
    },
  )

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

  // Note: callback methods must be defined before they are referenced in buildHandler
  private onConnect = (_connection: SSESession) => {
    // Setup subscription when connected
  }

  private onClose = (connection: SSESession, _reason: SSECloseReason) => {
    // Cleanup when connection closes
    // Resolve any pending handler resolver for this connection so completeHandler won't hang
    const resolve = this.handlerDoneResolvers.get(connection.id)
    if (resolve) {
      resolve()
      this.handlerDoneResolvers.delete(connection.id)
    }
  }

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<TestSSEContracts> {
    return {
      notificationsStream: this.handleStream,
    }
  }

  private handleStream = buildHandler(
    notificationsStreamContract,
    {
      sse: async (request, sse) => {
        const userId = request.query.userId ?? 'default'
        const connection = sse.start('keepAlive', { context: { userId } })

        // Wait for test to signal completion
        await new Promise<void>((resolve) => {
          this.handlerDoneResolvers.set(connection.id, resolve)
        })
      },
    },
    {
      onConnect: this.onConnect,
      onClose: this.onClose,
    },
  )

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
    predicate: (connection: SSESession) => boolean,
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
      chatCompletion: this.handleChatCompletion,
    }
  }

  private handleChatCompletion = buildHandler(chatCompletionContract, {
    sse: async (request, sse) => {
      const connection = sse.start('autoClose')
      // Simulate streaming response
      const words = request.body.message.split(' ')
      for (const word of words) {
        await connection.send('chunk', { content: word })
      }
      await connection.send('done', { totalTokens: words.length })
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
      authenticatedStream: this.handleAuthenticatedStream,
    }
  }

  private handleAuthenticatedStream = buildHandler(
    authenticatedStreamContract,
    {
      sse: async (_request, sse) => {
        const connection = sse.start('autoClose')
        await connection.send('data', { value: 'authenticated data' })
      },
    },
    {
      preHandler: (request, reply) => {
        const auth = request.headers.authorization
        if (!auth || !auth.startsWith('Bearer ')) {
          return Promise.resolve(reply.code(401).send({ error: 'Unauthorized' }))
        }
        return Promise.resolve()
      },
    },
  )
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
      channelStream: this.handleChannelStream,
    }
  }

  private handleChannelStream = buildHandler(channelStreamContract, {
    sse: async (request, sse) => {
      const connection = sse.start('autoClose', {
        context: { channelId: request.params.channelId },
      })
      await connection.send('message', {
        id: '1',
        content: `Welcome to channel ${request.params.channelId}`,
        author: 'system',
      })
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

  // Note: callback methods must be defined before they are referenced in buildHandler
  private handleReconnect = (
    _connection: SSESession,
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

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<TestReconnectSSEContracts> {
    return {
      reconnectStream: this.handleReconnectStream,
    }
  }

  private handleReconnectStream = buildHandler(
    reconnectStreamContract,
    {
      sse: async (_request, sse) => {
        const connection = sse.start('autoClose')
        // Send a new event after connection
        await connection.send('event', { id: '6', data: 'New event after reconnect' }, { id: '6' })
      },
    },
    {
      onReconnect: this.handleReconnect,
    },
  )

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

  // Note: callback methods must be defined before they are referenced in buildHandler
  // Async generator for replay - simulates fetching from database
  private handleReconnect = (
    _connection: SSESession,
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

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<TestAsyncReconnectSSEContracts> {
    return {
      asyncReconnectStream: this.handleReconnectStream,
    }
  }

  private handleReconnectStream = buildHandler(
    asyncReconnectStreamContract,
    {
      sse: async (_request, sse) => {
        const connection = sse.start('autoClose')
        // Send a new event after connection
        await connection.send(
          'event',
          { id: '4', data: 'Async new event after reconnect' },
          { id: '4' },
        )
      },
    },
    {
      onReconnect: this.handleReconnect,
    },
  )
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
      largeContentStream: this.handleLargeContentStream,
    }
  }

  private handleLargeContentStream = buildHandler(largeContentStreamContract, {
    sse: async (request, sse) => {
      const connection = sse.start('autoClose')
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
    },
  })
}

/**
 * Test SSE controller for logger error handling.
 * The onClose handler throws an error to test that:
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
      loggerTestStream: buildHandler(
        loggerTestStreamContract,
        {
          sse: async (_request, sse) => {
            const connection = sse.start('keepAlive')
            await connection.send('message', { text: 'Hello from logger test' })
            // Don't close connection - let client close to trigger onClose
          },
        },
        {
          logger: this.logger,
          onClose: () => {
            // Intentionally throw to test error handling
            throw new Error('Test error in onClose')
          },
        },
      ),
    }
  }
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
      validationTestStream: this.handleStream,
    }
  }

  private handleStream = buildHandler(validationTestStreamContract, {
    sse: async (request, sse) => {
      const connection = sse.start('autoClose')
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
      openaiStyleStream: this.handleOpenAIStyleStream,
    }
  }

  private handleOpenAIStyleStream = buildHandler(openaiStyleStreamContract, {
    sse: async (request, sse) => {
      const connection = sse.start('autoClose')
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
      onReconnectErrorStream: buildHandler(
        onReconnectErrorStreamContract,
        {
          sse: async (_request, sse) => {
            const connection = sse.start('autoClose')
            // Send message to verify connection still works after onReconnect error
            await connection.send('event', { id: 'new', data: 'Hello after onReconnect error' })
          },
        },
        {
          logger: this.logger,
          onReconnect: () => {
            // Intentionally throw to test error handling
            throw new Error('Test error in onReconnect')
          },
        },
      ),
    }
  }
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
      onConnectErrorStream: buildHandler(
        onConnectErrorStreamContract,
        {
          sse: async (_request, sse) => {
            const connection = sse.start('autoClose')
            // Send message to verify connection still works after onConnect error
            await connection.send('message', { text: 'Hello after onConnect error' })
          },
        },
        {
          logger: this.logger,
          onConnect: () => {
            // Intentionally throw to test error handling
            throw new Error('Test error in onConnect')
          },
        },
      ),
    }
  }
}

/**
 * Test SSE controller for logger error handling in onClose.
 * The onClose handler throws an error to test that:
 * 1. The logger is called with the error
 * 2. The connection closes properly despite the error
 */
export type TestOnCloseErrorSSEContracts = {
  onCloseErrorStream: typeof onCloseErrorStreamContract
}

export class TestOnCloseErrorSSEController extends AbstractSSEController<TestOnCloseErrorSSEContracts> {
  public static contracts = {
    onCloseErrorStream: onCloseErrorStreamContract,
  } as const

  private readonly logger: SSELogger

  constructor(deps: { logger: SSELogger }, sseConfig?: SSEControllerConfig) {
    super(deps, sseConfig)
    this.logger = deps.logger
  }

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<TestOnCloseErrorSSEContracts> {
    return {
      onCloseErrorStream: buildHandler(
        onCloseErrorStreamContract,
        {
          sse: async (_request, sse) => {
            const connection = sse.start('autoClose')
            // Send message then signal disconnect to trigger onClose
            await connection.send('message', { text: 'Hello before close' })
          },
        },
        {
          logger: this.logger,
          onClose: () => {
            // Intentionally throw to test error handling
            throw new Error('Test error in onClose')
          },
        },
      ),
    }
  }
}

/**
 * Test SSE controller for testing isConnected() method.
 */
export type TestIsConnectedSSEContracts = {
  isConnectedTestStream: typeof isConnectedTestStreamContract
}

export class TestIsConnectedSSEController extends AbstractSSEController<TestIsConnectedSSEContracts> {
  public static contracts = {
    isConnectedTestStream: isConnectedTestStreamContract,
  } as const

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<TestIsConnectedSSEContracts> {
    return {
      isConnectedTestStream: this.handleStream,
    }
  }

  private handleStream = buildHandler(isConnectedTestStreamContract, {
    sse: async (_request, sse) => {
      const connection = sse.start('autoClose')
      // Check if connected at start
      const wasConnected = connection.isConnected()
      await connection.send('status', { connected: wasConnected })
      await connection.send('done', { ok: true })
    },
  })
}

/**
 * Test SSE controller for testing sendStream() method with validation.
 */
export type TestSendStreamSSEContracts = {
  sendStreamTestStream: typeof sendStreamTestContract
}

export class TestSendStreamSSEController extends AbstractSSEController<TestSendStreamSSEContracts> {
  public static contracts = {
    sendStreamTestStream: sendStreamTestContract,
  } as const

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<TestSendStreamSSEContracts> {
    return {
      sendStreamTestStream: this.handleStream,
    }
  }

  private handleStream = buildHandler(sendStreamTestContract, {
    sse: async (request, sse) => {
      const connection = sse.start('autoClose')
      // Create an async generator that produces messages
      // biome-ignore lint/suspicious/useAwait: we need this for tests
      async function* generateMessages(sendInvalid: boolean) {
        yield { event: 'message' as const, data: { text: 'First message' } }
        if (sendInvalid) {
          // This will fail validation because 'text' should be string, not number
          yield { event: 'message' as const, data: { text: 123 as unknown as string } }
        }
        yield { event: 'done' as const, data: { ok: true } }
      }

      await connection.sendStream(generateMessages(request.body.sendInvalid ?? false))
    },
  })
}

/**
 * Test SSE controller for testing getStream() method.
 */
export type TestGetStreamSSEContracts = {
  getStreamTestStream: typeof getStreamTestContract
}

export class TestGetStreamSSEController extends AbstractSSEController<TestGetStreamSSEContracts> {
  public static contracts = {
    getStreamTestStream: getStreamTestContract,
  } as const

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<TestGetStreamSSEContracts> {
    return {
      getStreamTestStream: this.handleStream,
    }
  }

  private handleStream = buildHandler(getStreamTestContract, {
    sse: async (_request, sse) => {
      const connection = sse.start('autoClose')
      // Get the raw stream and verify it exists
      const stream = connection.getStream()
      const hasStream = stream !== null && stream !== undefined

      // Send a message confirming stream access
      await connection.send('message', {
        text: hasStream ? 'Got stream successfully' : 'Failed to get stream',
      })
    },
  })
}

// ============================================================================
// Deferred Headers Test Controllers
// ============================================================================

/**
 * Test SSE controller for deferred headers - 404 before streaming.
 * Demonstrates returning proper HTTP error codes before streaming starts.
 */
export type TestDeferredHeaders404Contracts = {
  deferred404: typeof deferredHeaders404Contract
}

export class TestDeferredHeaders404Controller extends AbstractSSEController<TestDeferredHeaders404Contracts> {
  public static contracts = {
    deferred404: deferredHeaders404Contract,
  } as const

  // Simulated entity storage
  private existingIds = new Set(['existing-123', 'another-456'])

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<TestDeferredHeaders404Contracts> {
    return {
      deferred404: this.handleStream,
    }
  }

  private handleStream = buildHandler(deferredHeaders404Contract, {
    sse: async (request, sse) => {
      const { id } = request.params

      // Early return BEFORE headers are sent - can return any HTTP response
      if (!this.existingIds.has(id)) {
        return sse.respond(404, { error: 'Entity not found', id })
      }

      // Entity exists - start streaming
      const session = sse.start('autoClose')
      await session.send('message', { text: `Found entity ${id}` })
    },
  })

  // For testing - add an ID to the "database"
  public addId(id: string): void {
    this.existingIds.add(id)
  }
}

/**
 * Test SSE controller for deferred headers - 422 validation errors.
 * Demonstrates custom validation that returns proper HTTP error codes.
 */
export type TestDeferredHeaders422Contracts = {
  validate: typeof deferredHeaders422Contract
}

export class TestDeferredHeaders422Controller extends AbstractSSEController<TestDeferredHeaders422Contracts> {
  public static contracts = {
    validate: deferredHeaders422Contract,
  } as const

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<TestDeferredHeaders422Contracts> {
    return {
      validate: this.handleStream,
    }
  }

  private handleStream = buildHandler(deferredHeaders422Contract, {
    sse: async (request, sse) => {
      const { value } = request.body

      // Custom validation beyond schema validation
      if (value < 0) {
        return sse.respond(422, {
          error: 'Validation failed',
          details: 'Value must be non-negative',
          received: value,
        })
      }

      if (value > 1000) {
        return sse.respond(422, {
          error: 'Validation failed',
          details: 'Value must be at most 1000',
          received: value,
        })
      }

      // Valid - start streaming
      const session = sse.start('autoClose')
      await session.send('result', { computed: value * 2 })
    },
  })
}

/**
 * Test SSE controller for forgotten start() detection.
 * Handler doesn't call start() or respond() - framework should detect this.
 */
export type TestForgottenStartContracts = {
  forgottenStart: typeof forgottenStartContract
}

export class TestForgottenStartController extends AbstractSSEController<TestForgottenStartContracts> {
  public static contracts = {
    forgottenStart: forgottenStartContract,
  } as const

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<TestForgottenStartContracts> {
    return {
      forgottenStart: this.handleStream,
    }
  }

  private handleStream = buildHandler(forgottenStartContract, {
    sse: (_request, _sse) => {
      // Bug: handler neither calls sse.start() nor sse.error()
      // Just returns without doing anything
      return undefined as unknown as SSEHandlerResult
    },
  })
}

/**
 * Test SSE controller for error thrown after start().
 * Handler throws an error after streaming has begun.
 */
export type TestErrorAfterStartContracts = {
  errorAfterStart: typeof errorAfterStartContract
}

export class TestErrorAfterStartController extends AbstractSSEController<TestErrorAfterStartContracts> {
  public static contracts = {
    errorAfterStart: errorAfterStartContract,
  } as const

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<TestErrorAfterStartContracts> {
    return {
      errorAfterStart: this.handleStream,
    }
  }

  private handleStream = buildHandler(errorAfterStartContract, {
    sse: async (_request, sse) => {
      // Start streaming (sends 200 + SSE headers)
      const connection = sse.start('autoClose')

      // Send a message successfully
      await connection.send('message', { text: 'First message' })

      // Then throw an error (simulating unexpected failure)
      throw new Error('Simulated error after streaming started')
    },
  })
}

/**
 * Test SSE controller for PublicNonRecoverableError with custom status code.
 * Throws the error BEFORE streaming starts to test proper HTTP response codes.
 */
export type TestPublicErrorContracts = {
  publicError: typeof publicErrorContract
}

export class TestPublicErrorController extends AbstractSSEController<TestPublicErrorContracts> {
  public static contracts = {
    publicError: publicErrorContract,
  } as const

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<TestPublicErrorContracts> {
    return {
      publicError: this.handleStream,
    }
  }

  private handleStream = buildHandler(publicErrorContract, {
    sse: (request, _sse) => {
      const statusCode = Number.parseInt(request.params.statusCode, 10)

      // Throw PublicNonRecoverableError BEFORE calling sse.start()
      // This tests that the framework respects the httpStatusCode property
      throw new PublicNonRecoverableError({
        message: `Custom error with status ${statusCode}`,
        errorCode: 'TEST_ERROR',
        httpStatusCode: statusCode,
      })
    },
  })
}

/**
 * Test SSE controller for non-Error throws.
 * Throws a non-Error object (plain object) to test error handling edge cases.
 */
export type TestNonErrorThrowContracts = {
  nonErrorThrow: typeof nonErrorThrowContract
}

export class TestNonErrorThrowController extends AbstractSSEController<TestNonErrorThrowContracts> {
  public static contracts = {
    nonErrorThrow: nonErrorThrowContract,
  } as const

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<TestNonErrorThrowContracts> {
    return {
      nonErrorThrow: this.handleStream,
    }
  }

  private handleStream = buildHandler(nonErrorThrowContract, {
    sse: (_request, _sse) => {
      // Throw a non-Error value (plain object without message) BEFORE calling sse.start()
      // This tests the edge case where isErrorLike returns false
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw { code: 'WEIRD_ERROR' }
    },
  })
}

/**
 * Test SSE controller for sse.respond() without explicit return.
 * Demonstrates that sse.respond() can be called in try/catch without returning.
 */
export type TestRespondWithoutReturnContracts = {
  respondWithoutReturn: typeof respondWithoutReturnContract
}

export class TestRespondWithoutReturnController extends AbstractSSEController<TestRespondWithoutReturnContracts> {
  public static contracts = {
    respondWithoutReturn: respondWithoutReturnContract,
  } as const

  // Simulated entity storage
  private existingIds = new Set(['exists-1', 'exists-2'])

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<TestRespondWithoutReturnContracts> {
    return {
      respondWithoutReturn: this.handleStream,
    }
  }

  private handleStream = buildHandler(respondWithoutReturnContract, {
    sse: async (request, sse) => {
      // This pattern demonstrates calling sse.respond() without returning it
      // Useful in try/catch blocks for error handling
      try {
        const entity = this.getEntity(request.params.id)
        // Entity found - start streaming
        const session = sse.start('autoClose')
        await session.send('message', { text: `Found: ${entity.name}` })
      } catch {
        // Note: NOT returning sse.respond() - just calling it
        sse.respond(404, { error: 'Entity not found', id: request.params.id })
      }
    },
  })

  private getEntity(id: string): { name: string } {
    if (!this.existingIds.has(id)) {
      throw new Error('Not found')
    }
    return { name: `Entity ${id}` }
  }
}

/**
 * Test SSE controller for responseSchemasByStatusCode validation.
 * Tests that sse.respond() validates against status-specific schemas.
 */
export type TestSSERespondValidationContracts = {
  sseRespondValidation: typeof sseRespondValidationContract
}

export class TestSSERespondValidationController extends AbstractSSEController<TestSSERespondValidationContracts> {
  public static contracts = {
    sseRespondValidation: sseRespondValidationContract,
  } as const

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<TestSSERespondValidationContracts> {
    return {
      sseRespondValidation: this.handleStream,
    }
  }

  private handleStream = buildHandler(sseRespondValidationContract, {
    sse: async (request, sse) => {
      const { returnStatus, returnValid } = request.body

      if (returnStatus === 400) {
        if (returnValid) {
          return sse.respond(400, {
            error: 'Bad Request',
            details: ['Invalid input', 'Missing field'],
          })
        }
        // Invalid response - missing 'details' field
        return sse.respond(400, { error: 'Bad Request', wrongField: 'invalid' } as any)
      }

      if (returnStatus === 404) {
        if (returnValid) {
          return sse.respond(404, { error: 'Not Found', resourceId: 'item-123' })
        }
        // Invalid response - missing 'resourceId' field
        return sse.respond(404, { error: 'Not Found', wrongField: 'invalid' } as any)
      }

      // Default: start streaming
      const session = sse.start('autoClose')
      await session.send('message', { text: 'Streaming started' })
    },
  })
}

// ============================================================================
// Room Test Controllers
// ============================================================================

/**
 * Test SSE controller for room functionality.
 * Demonstrates joining rooms, broadcasting to rooms, and auto-leave on disconnect.
 */
export type TestRoomContracts = {
  roomStream: typeof roomStreamContract
}

export class TestRoomSSEController extends AbstractSSEController<TestRoomContracts> {
  public static contracts = {
    roomStream: roomStreamContract,
  } as const

  constructor(deps: object, sseConfig?: SSEControllerConfig) {
    // Enable rooms for this controller
    super(deps, {
      ...sseConfig,
      rooms: sseConfig?.rooms ?? {},
    })
  }

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<TestRoomContracts> {
    return {
      roomStream: this.handleRoomStream,
    }
  }

  private handleRoomStream = buildHandler(
    roomStreamContract,
    {
      sse: async (request, sse) => {
        const { roomId } = request.params
        const userId = request.query.userId ?? 'anonymous'
        const connection = sse.start('keepAlive', { context: { userId, roomId } })

        // Join the room from the path parameter
        connection.rooms.join(roomId)

        // Notify others that this user joined (except self)
        await this.broadcastToRoom(
          roomId,
          { event: 'userJoined', data: { userId } },
          { except: connection.id },
        )
      },
    },
    {
      onClose: (connection) => {
        // Auto-leave is handled by the controller, but we can notify others
        const ctx = connection.context as { userId: string; roomId: string }
        // Note: We can't broadcast here because the connection is already being removed
        // In real apps, you'd store userId->connectionId mapping and handle this differently
      },
    },
  )

  // Test helpers - expose protected methods for testing
  public testBroadcastToRoom(
    room: string | string[],
    message: { event: string; data: unknown },
    options?: { except?: string | string[] },
  ) {
    return this.broadcastToRoom(room, message, options)
  }

  public testJoinRoom(connectionId: string, room: string | string[]) {
    return this.joinRoom(connectionId, room)
  }

  public testLeaveRoom(connectionId: string, room: string | string[]) {
    return this.leaveRoom(connectionId, room)
  }

  public testGetRooms(connectionId: string) {
    return this.getRooms(connectionId)
  }

  public testGetConnectionsInRoom(room: string) {
    return this.getConnectionsInRoom(room)
  }

  public testGetConnectionCountInRoom(room: string) {
    return this.getConnectionCountInRoom(room)
  }

  public get testRoomsEnabled() {
    return this.roomsEnabled
  }
}
