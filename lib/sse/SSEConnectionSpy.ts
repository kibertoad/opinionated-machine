import type { SSEConnection } from './AbstractSSEController.ts'

type ConnectionWaiter = {
  resolve: (connection: SSEConnection) => void
  reject: (error: Error) => void
  timeoutId: ReturnType<typeof setTimeout>
  predicate?: (connection: SSEConnection) => boolean
}

type DisconnectionWaiter = {
  connectionId: string
  resolve: () => void
  reject: (error: Error) => void
  timeoutId: ReturnType<typeof setTimeout>
}

export type SSEConnectionEvent = {
  type: 'connect' | 'disconnect'
  connectionId: string
  connection?: SSEConnection
}

/**
 * Connection spy for testing SSE controllers.
 * Tracks connection and disconnection events separately.
 */
export class SSEConnectionSpy {
  private events: SSEConnectionEvent[] = []
  private activeConnections: Set<string> = new Set()
  private claimedConnections: Set<string> = new Set()
  private connectionWaiters: ConnectionWaiter[] = []
  private disconnectionWaiters: DisconnectionWaiter[] = []

  /** @internal Called when a connection is established */
  addConnection(connection: SSEConnection): void {
    this.events.push({ type: 'connect', connectionId: connection.id, connection })
    this.activeConnections.add(connection.id)

    // Find and resolve first matching connection waiter
    const waiterIndex = this.connectionWaiters.findIndex(
      (w) => !w.predicate || w.predicate(connection),
    )
    if (waiterIndex !== -1) {
      // biome-ignore lint/style/noNonNullAssertion: we just received this index
      const waiter = this.connectionWaiters[waiterIndex]!
      this.connectionWaiters.splice(waiterIndex, 1)
      clearTimeout(waiter.timeoutId)
      this.claimedConnections.add(connection.id)
      waiter.resolve(connection)
    }
  }

  /** @internal Called when a connection is closed */
  addDisconnection(connectionId: string): void {
    this.events.push({ type: 'disconnect', connectionId })
    this.activeConnections.delete(connectionId)

    // Resolve pending disconnection waiters for this connection
    const waiterIndex = this.disconnectionWaiters.findIndex((w) => w.connectionId === connectionId)
    if (waiterIndex !== -1) {
      const waiter = this.disconnectionWaiters[waiterIndex]
      this.disconnectionWaiters.splice(waiterIndex, 1)
      if (waiter) {
        clearTimeout(waiter.timeoutId)
        waiter.resolve()
      }
    }
  }

  /**
   * Wait for a connection to be established.
   *
   * @param options.timeout - Timeout in milliseconds (default: 5000)
   * @param options.predicate - Optional predicate to match a specific connection.
   *   When provided, waits for an unclaimed connection that matches the predicate.
   *   Connections are "claimed" when returned by waitForConnection, allowing
   *   multiple sequential waits for the same URL path.
   *
   * @example
   * ```typescript
   * // Wait for any connection
   * const conn = await spy.waitForConnection()
   *
   * // Wait for a connection with specific URL
   * const conn = await spy.waitForConnection({
   *   predicate: (c) => c.request.url.includes('/api/notifications'),
   * })
   * ```
   */
  waitForConnection(options?: {
    timeout?: number
    predicate?: (connection: SSEConnection) => boolean
  }): Promise<SSEConnection> {
    const timeout = options?.timeout ?? 5000
    const predicate = options?.predicate

    // Check if a matching unclaimed connection already exists (must still be active)
    const connectEvent = this.events.find(
      (e) =>
        e.type === 'connect' &&
        e.connection &&
        !this.claimedConnections.has(e.connection.id) &&
        this.activeConnections.has(e.connection.id) &&
        (!predicate || predicate(e.connection)),
    )
    if (connectEvent?.connection) {
      this.claimedConnections.add(connectEvent.connection.id)
      return Promise.resolve(connectEvent.connection)
    }

    // No matching connection yet, create a waiter
    return new Promise<SSEConnection>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const index = this.connectionWaiters.findIndex((w) => w.resolve === resolve)
        if (index !== -1) {
          this.connectionWaiters.splice(index, 1)
        }
        reject(new Error(`Timeout waiting for connection after ${timeout}ms`))
      }, timeout)

      this.connectionWaiters.push({ resolve, reject, timeoutId, predicate })
    })
  }

  /** Wait for a specific connection to disconnect */
  waitForDisconnection(connectionId: string, options?: { timeout?: number }): Promise<void> {
    const timeout = options?.timeout ?? 5000

    // Check if already disconnected
    const hasDisconnected = this.events.some(
      (e) => e.type === 'disconnect' && e.connectionId === connectionId,
    )
    if (hasDisconnected) {
      return Promise.resolve()
    }

    // Not disconnected yet, create a waiter
    return new Promise<void>((resolve, reject) => {
      const waiter: DisconnectionWaiter = {
        connectionId,
        resolve,
        reject,
        timeoutId: setTimeout(() => {
          const index = this.disconnectionWaiters.indexOf(waiter)
          if (index !== -1) {
            this.disconnectionWaiters.splice(index, 1)
          }
          reject(new Error(`Timeout waiting for disconnection after ${timeout}ms`))
        }, timeout),
      }

      this.disconnectionWaiters.push(waiter)
    })
  }

  /** Check if a connection is currently active */
  isConnected(connectionId: string): boolean {
    return this.activeConnections.has(connectionId)
  }

  /** Get all connection events in order, optionally filtered by connectionId */
  getEvents(connectionId?: string): SSEConnectionEvent[] {
    if (connectionId === undefined) {
      return [...this.events]
    }
    return this.events.filter((e) => e.connectionId === connectionId)
  }

  /** Clear all events and cancel pending waiters */
  clear(): void {
    this.events = []
    this.activeConnections.clear()
    this.claimedConnections.clear()
    for (const waiter of this.connectionWaiters) {
      clearTimeout(waiter.timeoutId)
      waiter.reject(new Error('ConnectionSpy was cleared'))
    }
    for (const waiter of this.disconnectionWaiters) {
      clearTimeout(waiter.timeoutId)
      waiter.reject(new Error('ConnectionSpy was cleared'))
    }
    this.connectionWaiters = []
    this.disconnectionWaiters = []
  }
}
