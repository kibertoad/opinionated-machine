import type { SSEMessage } from '../../sseTypes.js'
import type { SSERoomAdapter, SSERoomMessageHandler } from '../types.js'

/**
 * Default no-op adapter for single-node deployments.
 *
 * This adapter does nothing - all room operations are local only.
 * Use this (the default) when running a single server instance.
 *
 * For multi-node deployments, use RedisAdapter or a custom adapter.
 */
export class InMemoryAdapter implements SSERoomAdapter {
  connect(): Promise<void> {
    // No-op for in-memory adapter
    return Promise.resolve()
  }

  disconnect(): Promise<void> {
    // No-op for in-memory adapter
    return Promise.resolve()
  }

  subscribe(_room: string): Promise<void> {
    // No-op for in-memory adapter - no cross-node subscription needed
    return Promise.resolve()
  }

  unsubscribe(_room: string): Promise<void> {
    // No-op for in-memory adapter
    return Promise.resolve()
  }

  publish(_room: string, _message: SSEMessage, _except?: string): Promise<void> {
    // No-op for in-memory adapter - messages are only sent locally
    // The controller handles local delivery directly
    return Promise.resolve()
  }

  onMessage(_handler: SSERoomMessageHandler): void {
    // No-op for in-memory adapter - messages are only local
  }
}
