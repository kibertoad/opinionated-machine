/**
 * Generic event service for testing SSE subscriptions
 */
export class EventService {
  private handlers = new Map<string, (data: unknown) => void>()

  subscribe(key: string, handler: (data: unknown) => void) {
    this.handlers.set(key, handler)
  }

  unsubscribe(key: string) {
    this.handlers.delete(key)
  }

  emit(key: string, data: unknown) {
    this.handlers.get(key)?.(data)
  }

  hasSubscriber(key: string) {
    return this.handlers.has(key)
  }
}

/**
 * Mock notification service for testing SSE subscriptions
 */
export class TestNotificationService {
  private subscribers = new Map<string, (notification: { id: string; message: string }) => void>()

  subscribe(userId: string, callback: (notification: { id: string; message: string }) => void) {
    this.subscribers.set(userId, callback)
  }

  unsubscribe(userId: string) {
    this.subscribers.delete(userId)
  }

  notify(userId: string, notification: { id: string; message: string }) {
    const callback = this.subscribers.get(userId)
    if (callback) {
      callback(notification)
    }
  }

  notifyAll(notification: { id: string; message: string }) {
    for (const callback of this.subscribers.values()) {
      callback(notification)
    }
  }

  getSubscriberCount() {
    return this.subscribers.size
  }

  hasSubscriber(userId: string) {
    return this.subscribers.has(userId)
  }
}
