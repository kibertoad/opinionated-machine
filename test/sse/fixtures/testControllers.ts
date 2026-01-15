import type { FastifyRequest } from 'fastify'
import {
  AbstractSSEController,
  type BuildSSERoutesReturnType,
  type SSEConnection,
  type SSEControllerConfig,
} from '../../../index.js'
import {
  asyncReconnectStreamContract,
  authenticatedStreamContract,
  channelStreamContract,
  chatCompletionContract,
  notificationsStreamContract,
  reconnectStreamContract,
  streamContract,
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

  buildSSERoutes(): BuildSSERoutesReturnType<{ stream: typeof streamContract }> {
    return {
      stream: {
        contract: StreamController.contracts.stream,
        handler: this.handleStream,
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

  private handleStream = (
    request: FastifyRequest<{ Querystring: { userId?: string } }>,
    connection: SSEConnection,
  ) => {
    const userId = request.query.userId ?? 'anonymous'
    connection.context = { userId }

    // Subscribe to events for this connection
    this.eventService.subscribe(connection.id, async (data) => {
      await this.sendEvent(connection.id, { event: 'message', data })
    })
  }

  // Testing helper
  pushToConnection(connectionId: string, data: unknown) {
    return this.sendEvent(connectionId, { event: 'message', data })
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

  public buildSSERoutes(): BuildSSERoutesReturnType<TestSSEContracts> {
    return {
      notificationsStream: {
        contract: TestSSEController.contracts.notificationsStream,
        handler: this.handleStream,
        options: {
          onConnect: this.onConnect,
          onDisconnect: this.onDisconnect,
        },
      },
    }
  }

  private handleStream = async (
    request: FastifyRequest<{ Querystring: { userId?: string } }>,
    connection: SSEConnection,
  ) => {
    const userId = request.query.userId ?? 'default'
    connection.context = { userId }

    // Wait for test to signal completion
    await new Promise<void>((resolve) => {
      this.handlerDoneResolvers.set(connection.id, resolve)
    })
  }

  private onConnect = (_connection: SSEConnection) => {
    // Setup subscription when connected
  }

  private onDisconnect = (_connection: SSEConnection) => {
    // Cleanup when disconnected
  }

  /** Call this from tests to signal the handler can complete */
  public completeHandler(connectionId: string): void {
    const resolve = this.handlerDoneResolvers.get(connectionId)
    if (resolve) {
      resolve()
      this.handlerDoneResolvers.delete(connectionId)
    }
  }

  // Expose methods for testing
  public testSendEvent(
    connectionId: string,
    message: { event?: string; data: unknown; id?: string },
  ) {
    return this.sendEvent(connectionId, message)
  }

  public testBroadcast(message: { event?: string; data: unknown }) {
    return this.broadcast(message)
  }

  public testBroadcastIf(
    message: { event?: string; data: unknown },
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

  public buildSSERoutes(): BuildSSERoutesReturnType<TestPostSSEContracts> {
    return {
      chatCompletion: {
        contract: TestPostSSEController.contracts.chatCompletion,
        handler: this.handleChatCompletion,
      },
    }
  }

  private handleChatCompletion = async (
    request: FastifyRequest<{ Body: { message: string; stream: true } }>,
    connection: SSEConnection,
  ) => {
    // Simulate streaming response
    const words = request.body.message.split(' ')
    for (const word of words) {
      await this.sendEvent(connection.id, {
        event: 'chunk',
        data: { content: word },
      })
    }
    await this.sendEvent(connection.id, {
      event: 'done',
      data: { totalTokens: words.length },
    })
    this.closeConnection(connection.id)
  }
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

  public buildSSERoutes(): BuildSSERoutesReturnType<TestAuthSSEContracts> {
    return {
      authenticatedStream: {
        contract: TestAuthSSEController.contracts.authenticatedStream,
        handler: this.handleAuthenticatedStream,
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

  private handleAuthenticatedStream = async (
    _request: FastifyRequest<{ Headers: { authorization: string } }>,
    connection: SSEConnection,
  ) => {
    await this.sendEvent(connection.id, {
      event: 'data',
      data: { value: 'authenticated data' },
    })
    // Close connection after sending - needed for inject tests to complete
    this.closeConnection(connection.id)
  }
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

  public buildSSERoutes(): BuildSSERoutesReturnType<TestChannelSSEContracts> {
    return {
      channelStream: {
        contract: TestChannelSSEController.contracts.channelStream,
        handler: this.handleChannelStream,
      },
    }
  }

  private handleChannelStream = async (
    request: FastifyRequest<{
      Params: { channelId: string }
      Querystring: { since?: string }
    }>,
    connection: SSEConnection,
  ) => {
    connection.context = { channelId: request.params.channelId }
    await this.sendEvent(connection.id, {
      event: 'message',
      data: {
        id: '1',
        content: `Welcome to channel ${request.params.channelId}`,
        author: 'system',
      },
    })
    // Close connection after sending - needed for inject tests to complete
    this.closeConnection(connection.id)
  }
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

  public buildSSERoutes(): BuildSSERoutesReturnType<TestReconnectSSEContracts> {
    return {
      reconnectStream: {
        contract: TestReconnectSSEController.contracts.reconnectStream,
        handler: this.handleReconnectStream,
        options: {
          onReconnect: this.handleReconnect,
        },
      },
    }
  }

  private handleReconnectStream = async (_request: FastifyRequest, connection: SSEConnection) => {
    // Send a new event after connection
    await this.sendEvent(connection.id, {
      event: 'event',
      data: { id: '6', data: 'New event after reconnect' },
      id: '6',
    })
    this.closeConnection(connection.id)
  }

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

  public buildSSERoutes(): BuildSSERoutesReturnType<TestAsyncReconnectSSEContracts> {
    return {
      asyncReconnectStream: {
        contract: TestAsyncReconnectSSEController.contracts.asyncReconnectStream,
        handler: this.handleReconnectStream,
        options: {
          onReconnect: this.handleReconnect,
        },
      },
    }
  }

  private handleReconnectStream = async (_request: FastifyRequest, connection: SSEConnection) => {
    // Send a new event after connection
    await this.sendEvent(connection.id, {
      event: 'event',
      data: { id: '4', data: 'Async new event after reconnect' },
      id: '4',
    })
    this.closeConnection(connection.id)
  }

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
