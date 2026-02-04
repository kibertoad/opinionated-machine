import type { SSEMessage } from '../../sseTypes.ts'
import type { SSERoomAdapter, SSERoomMessageHandler } from '../types.ts'

/**
 * Default no-op adapter for single-node deployments.
 *
 * This adapter does nothing - all room operations are local only.
 * Use this (the default) when running a single server instance.
 *
 * For multi-node deployments, use RedisAdapter or a custom adapter.
 */
export class InMemoryAdapter implements SSERoomAdapter {
  private handler?: SSERoomMessageHandler

  async connect(): Promise<void> {
    // No-op for in-memory adapter
  }

  async disconnect(): Promise<void> {
    // No-op for in-memory adapter
  }

  async subscribe(_room: string): Promise<void> {
    // No-op for in-memory adapter - no cross-node subscription needed
  }

  async unsubscribe(_room: string): Promise<void> {
    // No-op for in-memory adapter
  }

  async publish(_room: string, _message: SSEMessage, _except?: string): Promise<void> {
    // No-op for in-memory adapter - messages are only sent locally
    // The controller handles local delivery directly
  }

  onMessage(handler: SSERoomMessageHandler): void {
    this.handler = handler
  }
}
