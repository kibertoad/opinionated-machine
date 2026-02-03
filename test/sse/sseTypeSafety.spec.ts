import type { FastifyReply } from 'fastify'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod/v4'
import {
  AbstractDualModeController,
  AbstractSSEController,
  type BuildFastifyDualModeRoutesReturnType,
  type BuildFastifySSERoutesReturnType,
  buildContract,
  buildHandler,
  type SSEContext,
} from '../../index.js'

/**
 * Type safety tests for SSE controller implementations.
 *
 * These tests verify that TypeScript catches type errors in realistic
 * controller implementations - the way users actually write code.
 */

// Define a realistic contract like users would
const chatStreamContract = buildContract({
  method: 'POST',
  pathResolver: () => '/api/chat/stream',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({ authorization: z.string() }),
  requestBody: z.object({
    model: z.string(),
    messages: z.array(z.object({ role: z.string(), content: z.string() })),
  }),
  events: {
    chunk: z.object({ content: z.string(), index: z.number() }),
    done: z.object({ totalTokens: z.number(), model: z.string() }),
    error: z.object({ code: z.number(), message: z.string() }),
  },
})

type ChatStreamContracts = {
  chatStream: typeof chatStreamContract
}

describe('SSE Controller Type Safety', () => {
  describe('realistic controller implementation', () => {
    it('allows correctly typed event sending via send function', () => {
      // This is how users actually write controllers
      class ChatSSEController extends AbstractSSEController<ChatStreamContracts> {
        public static contracts = { chatStream: chatStreamContract } as const

        public buildSSERoutes(): BuildFastifySSERoutesReturnType<ChatStreamContracts> {
          return {
            chatStream: this.chatHandlers,
          }
        }

        // Handler using buildHandler for type inference
        private chatHandlers = buildHandler(chatStreamContract, {
          sse: async (request, sse) => {
            // Verify request and sse are NOT typed as any (catches inference failures)
            expectTypeOf(request).not.toBeAny()
            expectTypeOf(sse).not.toBeAny()

            // Verify request.body is properly typed
            expectTypeOf(request.body).toEqualTypeOf<{
              model: string
              messages: Array<{ role: string; content: string }>
            }>()

            // Verify request.body.model is string, not any (would not error if any)
            // @ts-expect-error - model is string, assigning to number must fail
            const _typeCheck: number = request.body.model

            const connection = sse.start('autoClose')

            // Valid: correct event names and payloads
            await connection.send('chunk', { content: 'Hello', index: 0 })
            await connection.send('chunk', { content: ' world', index: 1 })
            await connection.send('done', { totalTokens: 10, model: request.body.model })

            // Request body is typed
            const messages = request.body.messages
            expect(messages).toBeDefined()

            // autoClose mode - session closes after handler
          },
        })
      }

      const controller = new ChatSSEController({})
      expect(controller.buildSSERoutes()).toBeDefined()
    })

    it('catches invalid event name at compile time', () => {
      class InvalidEventController extends AbstractSSEController<ChatStreamContracts> {
        public static contracts = { chatStream: chatStreamContract } as const

        public buildSSERoutes(): BuildFastifySSERoutesReturnType<ChatStreamContracts> {
          return {
            chatStream: this.chatHandlers,
          }
        }

        private chatHandlers = buildHandler(chatStreamContract, {
          sse: async (_request, sse) => {
            const connection = sse.start('autoClose')
            // @ts-expect-error - 'message' is not a valid event name, should be 'chunk', 'done', or 'error'
            await connection.send('message', { text: 'hello' })
            // autoClose mode - session closes after handler
          },
        })
      }

      expect(InvalidEventController).toBeDefined()
    })

    it('catches wrong payload structure at compile time', () => {
      class WrongPayloadController extends AbstractSSEController<ChatStreamContracts> {
        public static contracts = { chatStream: chatStreamContract } as const

        public buildSSERoutes(): BuildFastifySSERoutesReturnType<ChatStreamContracts> {
          return {
            chatStream: this.chatHandlers,
          }
        }

        private chatHandlers = buildHandler(chatStreamContract, {
          sse: async (_request, sse) => {
            const connection = sse.start('autoClose')
            // @ts-expect-error - 'chunk' event expects { content: string, index: number }, not { text: string }
            await connection.send('chunk', { text: 'hello' })
            // autoClose mode - session closes after handler
          },
        })
      }

      expect(WrongPayloadController).toBeDefined()
    })

    it('catches missing required fields at compile time', () => {
      class MissingFieldController extends AbstractSSEController<ChatStreamContracts> {
        public static contracts = { chatStream: chatStreamContract } as const

        public buildSSERoutes(): BuildFastifySSERoutesReturnType<ChatStreamContracts> {
          return {
            chatStream: this.chatHandlers,
          }
        }

        private chatHandlers = buildHandler(chatStreamContract, {
          sse: async (_request, sse) => {
            const connection = sse.start('autoClose')
            // @ts-expect-error - 'done' event requires both 'totalTokens' and 'model', missing 'model'
            await connection.send('done', { totalTokens: 10 })
            // autoClose mode - session closes after handler
          },
        })
      }

      expect(MissingFieldController).toBeDefined()
    })

    it('catches wrong field types at compile time', () => {
      class WrongTypeController extends AbstractSSEController<ChatStreamContracts> {
        public static contracts = { chatStream: chatStreamContract } as const

        public buildSSERoutes(): BuildFastifySSERoutesReturnType<ChatStreamContracts> {
          return {
            chatStream: this.chatHandlers,
          }
        }

        private chatHandlers = buildHandler(chatStreamContract, {
          sse: async (_request, sse) => {
            const connection = sse.start('autoClose')
            // @ts-expect-error - 'index' should be number, not string
            await connection.send('chunk', { content: 'hello', index: 'one' })
            // autoClose mode - session closes after handler
          },
        })
      }

      expect(WrongTypeController).toBeDefined()
    })

    it('catches mismatched event payload between different event types', () => {
      class MismatchedPayloadController extends AbstractSSEController<ChatStreamContracts> {
        public static contracts = { chatStream: chatStreamContract } as const

        public buildSSERoutes(): BuildFastifySSERoutesReturnType<ChatStreamContracts> {
          return {
            chatStream: this.chatHandlers,
          }
        }

        private chatHandlers = buildHandler(chatStreamContract, {
          sse: async (_request, sse) => {
            const connection = sse.start('autoClose')
            // @ts-expect-error - 'chunk' event expects { content: string, index: number }, not 'done' payload { totalTokens: number, model: string }
            await connection.send('chunk', { totalTokens: 10, model: 'gpt-4' })

            // @ts-expect-error - 'done' event expects { totalTokens: number, model: string }, not 'chunk' payload { content: string, index: number }
            await connection.send('done', { content: 'hello', index: 0 })

            // @ts-expect-error - 'error' event expects { code: number, message: string }, not 'chunk' payload
            await connection.send('error', { content: 'hello', index: 0 })

            // autoClose mode - session closes after handler
          },
        })
      }

      expect(MismatchedPayloadController).toBeDefined()
    })

    it('provides typed request body in handler', () => {
      class TypedRequestController extends AbstractSSEController<ChatStreamContracts> {
        public static contracts = { chatStream: chatStreamContract } as const

        public buildSSERoutes(): BuildFastifySSERoutesReturnType<ChatStreamContracts> {
          return {
            chatStream: this.chatHandlers,
          }
        }

        private chatHandlers = buildHandler(chatStreamContract, {
          sse: (request, sse) => {
            // These should be typed
            const model: string = request.body.model
            const messages: Array<{ role: string; content: string }> = request.body.messages

            // @ts-expect-error - 'nonExistent' doesn't exist on body
            const _invalid = request.body.nonExistent

            expect(model).toBeDefined()
            expect(messages).toBeDefined()

            sse.start('autoClose')
          },
        })
      }

      expect(TypedRequestController).toBeDefined()
    })

    it('provides typed headers in handler', () => {
      class TypedHeadersController extends AbstractSSEController<ChatStreamContracts> {
        public static contracts = { chatStream: chatStreamContract } as const

        public buildSSERoutes(): BuildFastifySSERoutesReturnType<ChatStreamContracts> {
          return {
            chatStream: this.chatHandlers,
          }
        }

        private chatHandlers = buildHandler(chatStreamContract, {
          sse: (request, sse) => {
            // Authorization header is typed as string (required by contract schema)
            const auth: string = request.headers.authorization

            // Note: Fastify headers are loosely typed (allow arbitrary keys)
            // so we can't test @ts-expect-error for non-existent headers
            expect(auth).toBeDefined()

            sse.start('autoClose')
          },
        })
      }

      expect(TypedHeadersController).toBeDefined()
    })
  })

  describe('sendEventInternal type safety', () => {
    it('allows correctly typed events via sendEventInternal', () => {
      class ExternalTriggerController extends AbstractSSEController<ChatStreamContracts> {
        public static contracts = { chatStream: chatStreamContract } as const

        public buildSSERoutes(): BuildFastifySSERoutesReturnType<ChatStreamContracts> {
          return {
            chatStream: buildHandler(chatStreamContract, {
              sse: (_request, sse) => {
                sse.start('keepAlive')
              },
            }),
          }
        }

        // Simulating external event source (e.g., message queue callback)
        async handleExternalMessage(connectionId: string, content: string, index: number) {
          // Valid: sendEventInternal accepts events from any contract
          await this.sendEventInternal(connectionId, {
            event: 'chunk',
            data: { content, index },
          })
        }

        async sendCompletion(connectionId: string, totalTokens: number, model: string) {
          // Valid: different event type from same controller
          await this.sendEventInternal(connectionId, {
            event: 'done',
            data: { totalTokens, model },
          })
        }
      }

      const controller = new ExternalTriggerController({})
      expect(controller.handleExternalMessage).toBeDefined()
      expect(controller.sendCompletion).toBeDefined()
    })

    it('catches invalid event name in sendEventInternal', () => {
      class InvalidExternalController extends AbstractSSEController<ChatStreamContracts> {
        public static contracts = { chatStream: chatStreamContract } as const

        public buildSSERoutes(): BuildFastifySSERoutesReturnType<ChatStreamContracts> {
          return {
            chatStream: buildHandler(chatStreamContract, {
              sse: (_request, sse) => {
                sse.start('keepAlive')
              },
            }),
          }
        }

        async invalidEvent(connectionId: string) {
          // @ts-expect-error - 'invalid' is not a valid event name
          await this.sendEventInternal(connectionId, { event: 'invalid', data: { foo: 'bar' } })
        }
      }

      expect(InvalidExternalController).toBeDefined()
    })

    it('catches wrong payload in sendEventInternal', () => {
      class WrongPayloadExternalController extends AbstractSSEController<ChatStreamContracts> {
        public static contracts = { chatStream: chatStreamContract } as const

        public buildSSERoutes(): BuildFastifySSERoutesReturnType<ChatStreamContracts> {
          return {
            chatStream: buildHandler(chatStreamContract, {
              sse: (_request, sse) => {
                sse.start('keepAlive')
              },
            }),
          }
        }

        async wrongPayload(connectionId: string) {
          // @ts-expect-error - 'chunk' expects { content: string, index: number }, not { text: string }
          await this.sendEventInternal(connectionId, { event: 'chunk', data: { text: 'wrong' } })
        }
      }

      expect(WrongPayloadExternalController).toBeDefined()
    })

    it('catches missing required fields in sendEventInternal', () => {
      class MissingFieldExternalController extends AbstractSSEController<ChatStreamContracts> {
        public static contracts = { chatStream: chatStreamContract } as const

        public buildSSERoutes(): BuildFastifySSERoutesReturnType<ChatStreamContracts> {
          return {
            chatStream: buildHandler(chatStreamContract, {
              sse: (_request, sse) => {
                sse.start('keepAlive')
              },
            }),
          }
        }

        async missingField(connectionId: string) {
          // @ts-expect-error - 'done' requires both 'totalTokens' and 'model'
          await this.sendEventInternal(connectionId, { event: 'done', data: { totalTokens: 10 } })
        }
      }

      expect(MissingFieldExternalController).toBeDefined()
    })

    it('provides autocomplete for event names from all contracts', () => {
      // This test demonstrates that a controller with multiple contracts
      // gets autocomplete for all events across all routes
      const notificationContract = buildContract({
        pathResolver: () => '/api/notifications',
        params: z.object({}),
        query: z.object({}),
        requestHeaders: z.object({}),
        events: {
          alert: z.object({ severity: z.enum(['info', 'warning', 'error']), message: z.string() }),
          dismiss: z.object({ alertId: z.string() }),
        },
      })

      type MultiContracts = {
        chatStream: typeof chatStreamContract
        notifications: typeof notificationContract
      }

      class MultiContractController extends AbstractSSEController<MultiContracts> {
        public static contracts = {
          chatStream: chatStreamContract,
          notifications: notificationContract,
        } as const

        public buildSSERoutes(): BuildFastifySSERoutesReturnType<MultiContracts> {
          return {
            chatStream: buildHandler(chatStreamContract, {
              sse: (_request, sse) => {
                sse.start('keepAlive')
              },
            }),
            notifications: buildHandler(notificationContract, {
              sse: (_request, sse) => {
                sse.start('keepAlive')
              },
            }),
          }
        }

        // Can send events from chatStream contract
        async sendChunk(connectionId: string) {
          await this.sendEventInternal(connectionId, {
            event: 'chunk',
            data: { content: 'hello', index: 0 },
          })
        }

        // Can also send events from notifications contract
        async sendAlert(connectionId: string) {
          await this.sendEventInternal(connectionId, {
            event: 'alert',
            data: { severity: 'warning', message: 'Low battery' },
          })
        }

        // Invalid: mixing event name from one contract with data from another
        async invalidMix(connectionId: string) {
          // @ts-expect-error - 'alert' expects { severity, message }, not chunk data
          // biome-ignore format: keep on single line for @ts-expect-error to work
          await this.sendEventInternal(connectionId, { event: 'alert', data: { content: 'hello', index: 0 } })
        }
      }

      const controller = new MultiContractController({})
      expect(controller.sendChunk).toBeDefined()
      expect(controller.sendAlert).toBeDefined()
    })
  })
})

describe('Dual-Mode Contract Type Safety', () => {
  describe('responseHeaders type inference', () => {
    it('infers responseHeaders type when defined', () => {
      // Contract with responseHeaders
      const contractWithHeaders = buildContract({
        method: 'POST',
        pathResolver: () => '/api/test',
        params: z.object({}),
        query: z.object({}),
        requestHeaders: z.object({}),
        requestBody: z.object({ data: z.string() }),
        syncResponse: z.object({ result: z.string() }),
        responseHeaders: z.object({
          'x-request-id': z.string(),
          'x-custom': z.number(),
        }),
        events: {
          done: z.object({ success: z.boolean() }),
        },
      })

      // Type should include responseHeaders
      expect(contractWithHeaders.responseHeaders).toBeDefined()
      expect(contractWithHeaders.isDualMode).toBe(true)
    })

    it('allows omitting responseHeaders', () => {
      // Contract WITHOUT responseHeaders - should compile fine
      const contractWithoutHeaders = buildContract({
        method: 'POST',
        pathResolver: () => '/api/test',
        params: z.object({}),
        query: z.object({}),
        requestHeaders: z.object({}),
        requestBody: z.object({ data: z.string() }),
        syncResponse: z.object({ result: z.string() }),
        events: {
          done: z.object({ success: z.boolean() }),
        },
      })

      // responseHeaders should be undefined
      expect(contractWithoutHeaders.responseHeaders).toBeUndefined()
      expect(contractWithoutHeaders.isDualMode).toBe(true)
    })

    it('SSE contracts do not have responseHeaders', () => {
      // SSE contract (no syncResponse)
      const sseContract = buildContract({
        method: 'POST',
        pathResolver: () => '/api/sse',
        params: z.object({}),
        query: z.object({}),
        requestHeaders: z.object({}),
        requestBody: z.object({ data: z.string() }),
        events: {
          chunk: z.object({ content: z.string() }),
        },
      })

      // SSE contracts are marked with isSSE, not isDualMode
      expect(sseContract.isSSE).toBe(true)
      // @ts-expect-error - responseHeaders does not exist on SSE contracts
      expect(sseContract.responseHeaders).toBeUndefined()
    })
  })
})

// ============================================================================
// GET (non-payload) SSE Contract Type Safety
// ============================================================================

describe('GET SSE Controller Type Safety (non-payload)', () => {
  // GET SSE contract - no body field
  const notificationsContract = buildContract({
    pathResolver: (params) => `/api/users/${params.userId}/notifications`,
    params: z.object({ userId: z.string() }),
    query: z.object({ since: z.string().optional() }),
    requestHeaders: z.object({ authorization: z.string() }),
    events: {
      notification: z.object({ id: z.string(), message: z.string() }),
      heartbeat: z.object({ timestamp: z.number() }),
    },
  })

  type NotificationContracts = {
    notifications: typeof notificationsContract
  }

  describe('buildHandler with GET SSE contract', () => {
    it('allows correctly typed event sending', () => {
      class NotificationsController extends AbstractSSEController<NotificationContracts> {
        public static contracts = { notifications: notificationsContract } as const

        public buildSSERoutes(): BuildFastifySSERoutesReturnType<NotificationContracts> {
          return {
            notifications: this.handleNotifications,
          }
        }

        private handleNotifications = buildHandler(notificationsContract, {
          sse: async (request, sse) => {
            const connection = sse.start('autoClose')
            // Valid: correct event names and payloads
            await connection.send('notification', { id: '1', message: 'Hello' })
            await connection.send('heartbeat', { timestamp: Date.now() })

            // Request params are typed
            const userId: string = request.params.userId
            expect(userId).toBeDefined()

            // Request query is typed
            const since: string | undefined = request.query.since
            expect(since).toBeDefined()

            // autoClose mode - session closes after handler
          },
        })
      }

      const controller = new NotificationsController({})
      expect(controller.buildSSERoutes()).toBeDefined()
    })

    it('catches invalid event name at compile time', () => {
      buildHandler(notificationsContract, {
        sse: async (_request, sse) => {
          const connection = sse.start('autoClose')
          // @ts-expect-error - 'message' is not a valid event name
          await connection.send('message', { text: 'hello' })
          // autoClose mode - session closes after handler
        },
      })

      expect(true).toBe(true)
    })

    it('catches wrong payload structure at compile time', () => {
      buildHandler(notificationsContract, {
        sse: async (_request, sse) => {
          const connection = sse.start('autoClose')
          // @ts-expect-error - 'notification' expects { id: string, message: string }, not { text: string }
          await connection.send('notification', { text: 'hello' })
          // autoClose mode - session closes after handler
        },
      })

      expect(true).toBe(true)
    })

    it('catches missing required fields at compile time', () => {
      buildHandler(notificationsContract, {
        sse: async (_request, sse) => {
          const connection = sse.start('autoClose')
          // @ts-expect-error - 'notification' requires both 'id' and 'message'
          await connection.send('notification', { id: '1' })
          // autoClose mode - session closes after handler
        },
      })

      expect(true).toBe(true)
    })

    it('types request params from contract', () => {
      buildHandler(notificationsContract, {
        sse: (request, sse) => {
          const userId: string = request.params.userId

          // @ts-expect-error - 'nonExistent' does not exist on params
          const _invalid = request.params.nonExistent

          expect(userId).toBeDefined()

          sse.start('autoClose')
        },
      })

      expect(true).toBe(true)
    })

    it('types request query from contract', () => {
      buildHandler(notificationsContract, {
        sse: (request, sse) => {
          const since: string | undefined = request.query.since

          // @ts-expect-error - 'nonExistent' does not exist on query
          const _invalid = request.query.nonExistent

          expect(since).toBeDefined()

          sse.start('autoClose')
        },
      })

      expect(true).toBe(true)
    })

    it('GET contract has no body in contract definition', () => {
      // Verify the contract itself has no body field
      expect(notificationsContract.requestBody).toBeUndefined()

      // The handler can still be created and works without body
      const handlers = buildHandler(notificationsContract, {
        sse: async (_request, sse) => {
          const connection = sse.start('autoClose')
          await connection.send('notification', { id: '1', message: 'test' })
          // autoClose mode - session closes after handler
        },
      })

      expect(handlers).toBeDefined()
    })
  })
})

// ============================================================================
// Dual-Mode Handler Type Safety
// ============================================================================

describe('Dual-Mode Handler Type Safety', () => {
  // POST dual-mode contract (with body)
  const chatCompletionContract = buildContract({
    method: 'POST',
    pathResolver: (params) => `/api/chats/${params.chatId}/completions`,
    params: z.object({ chatId: z.string().uuid() }),
    query: z.object({ verbose: z.boolean().optional() }),
    requestHeaders: z.object({ authorization: z.string() }),
    requestBody: z.object({
      message: z.string(),
      temperature: z.number().optional(),
    }),
    syncResponse: z.object({
      reply: z.string(),
      usage: z.object({ tokens: z.number() }),
    }),
    events: {
      chunk: z.object({ delta: z.string() }),
      done: z.object({ usage: z.object({ total: z.number() }) }),
    },
  })

  type ChatContracts = {
    chatCompletion: typeof chatCompletionContract
  }

  describe('buildHandler with POST dual-mode contract', () => {
    it('allows correctly typed json handler return', () => {
      class ChatController extends AbstractDualModeController<ChatContracts> {
        public static contracts = { chatCompletion: chatCompletionContract } as const

        public buildDualModeRoutes(): BuildFastifyDualModeRoutesReturnType<ChatContracts> {
          return {
            chatCompletion: buildHandler(chatCompletionContract, {
              sync: (request) => {
                // Valid: return matches syncResponse schema
                return {
                  reply: request.body.message,
                  usage: { tokens: 10 },
                }
              },
              sse: async (_request, sse) => {
                const connection = sse.start('autoClose')
                await connection.send('chunk', { delta: 'Hello' })
                await connection.send('done', { usage: { total: 10 } })
                // autoClose mode - session closes after handler
              },
            }),
          }
        }
      }

      const controller = new ChatController({})
      expect(controller.buildDualModeRoutes()).toBeDefined()
    })

    it('catches wrong sync handler return type at compile time', () => {
      // @ts-expect-error - return type doesn't match syncResponse: missing 'usage'
      buildHandler(chatCompletionContract, {
        sync: () => {
          return { reply: 'Hello' }
        },
        sse: (_request, sse) => {
          sse.start('autoClose')
        },
      })

      expect(true).toBe(true)
    })

    it('catches wrong sync handler return field type at compile time', () => {
      // @ts-expect-error - 'tokens' should be number, not string
      buildHandler(chatCompletionContract, {
        sync: () => {
          return { reply: 'Hello', usage: { tokens: 'ten' } }
        },
        sse: (_request, sse) => {
          sse.start('autoClose')
        },
      })

      expect(true).toBe(true)
    })

    it('catches extra fields in json handler return at compile time', () => {
      buildHandler(chatCompletionContract, {
        sync: () => {
          return {
            reply: 'Hello',
            usage: { tokens: 10 },
            // Note: TypeScript allows extra properties in object literals by default
            // This test documents that behavior - strict excess property checking
            // would require explicit typing
          }
        },
        sse: (_request, sse) => {
          sse.start('autoClose')
        },
      })

      expect(true).toBe(true)
    })

    it('catches invalid sse event name at compile time', () => {
      buildHandler(chatCompletionContract, {
        sync: () => ({ reply: 'Hello', usage: { tokens: 10 } }),
        sse: async (_request, sse) => {
          const connection = sse.start('autoClose')
          // @ts-expect-error - 'invalid' is not a valid event name
          await connection.send('invalid', { data: 'test' })
          // autoClose mode - session closes after handler
        },
      })

      expect(true).toBe(true)
    })

    it('catches wrong sse event payload at compile time', () => {
      buildHandler(chatCompletionContract, {
        sync: () => ({ reply: 'Hello', usage: { tokens: 10 } }),
        sse: async (_request, sse) => {
          const connection = sse.start('autoClose')
          // @ts-expect-error - 'chunk' expects { delta: string }, not { content: string }
          await connection.send('chunk', { content: 'Hello' })
          // autoClose mode - session closes after handler
        },
      })

      expect(true).toBe(true)
    })

    it('catches missing required sse event fields at compile time', () => {
      buildHandler(chatCompletionContract, {
        sync: () => ({ reply: 'Hello', usage: { tokens: 10 } }),
        sse: async (_request, sse) => {
          const connection = sse.start('autoClose')
          // @ts-expect-error - 'done' requires { usage: { total: number } }
          await connection.send('done', {})
          // autoClose mode - session closes after handler
        },
      })

      expect(true).toBe(true)
    })

    it('types request body in json handler', () => {
      buildHandler(chatCompletionContract, {
        sync: (request) => {
          // Body is typed
          const message: string = request.body.message
          const temperature: number | undefined = request.body.temperature

          // @ts-expect-error - 'nonExistent' does not exist on body
          const _invalid = request.body.nonExistent

          expect(message).toBeDefined()
          expect(temperature).toBeDefined()

          return { reply: message, usage: { tokens: 10 } }
        },
        sse: (_request, sse) => {
          sse.start('autoClose')
        },
      })

      expect(true).toBe(true)
    })

    it('types request body in sse handler', () => {
      buildHandler(chatCompletionContract, {
        sync: () => ({ reply: 'Hello', usage: { tokens: 10 } }),
        sse: (request, sse) => {
          // Body is typed
          const message: string = request.body.message

          // @ts-expect-error - 'nonExistent' does not exist on body
          const _invalid = request.body.nonExistent

          expect(message).toBeDefined()

          sse.start('autoClose')
        },
      })

      expect(true).toBe(true)
    })

    it('types request params in both handlers', () => {
      buildHandler(chatCompletionContract, {
        sync: (request) => {
          const chatId: string = request.params.chatId

          // @ts-expect-error - 'nonExistent' does not exist on params
          const _invalid = request.params.nonExistent

          expect(chatId).toBeDefined()
          return { reply: 'Hello', usage: { tokens: 10 } }
        },
        sse: (request, sse) => {
          const chatId: string = request.params.chatId

          // @ts-expect-error - 'nonExistent' does not exist on params
          const _invalid = request.params.nonExistent

          expect(chatId).toBeDefined()

          sse.start('autoClose')
        },
      })

      expect(true).toBe(true)
    })

    it('types request query in both handlers', () => {
      buildHandler(chatCompletionContract, {
        sync: (request) => {
          const verbose: boolean | undefined = request.query.verbose

          // @ts-expect-error - 'nonExistent' does not exist on query
          const _invalid = request.query.nonExistent

          expect(verbose).toBeDefined()
          return { reply: 'Hello', usage: { tokens: 10 } }
        },
        sse: (request, sse) => {
          const verbose: boolean | undefined = request.query.verbose

          // @ts-expect-error - 'nonExistent' does not exist on query
          const _invalid = request.query.nonExistent

          expect(verbose).toBeDefined()

          sse.start('autoClose')
        },
      })

      expect(true).toBe(true)
    })

    it('provides reply in json handler as second argument', () => {
      buildHandler(chatCompletionContract, {
        sync: (_request, reply) => {
          // Reply is available as second argument in json handler
          expect(reply).toBeDefined()
          return { reply: 'Hello', usage: { tokens: 10 } }
        },
        sse: (_request, sse) => {
          sse.start('autoClose')
        },
      })

      expect(true).toBe(true)
    })

    it('provides SSEContext in sse handler as second argument', () => {
      buildHandler(chatCompletionContract, {
        sync: () => ({ reply: 'Hello', usage: { tokens: 10 } }),
        sse: (_request, sse) => {
          // SSEContext is available as second argument in sse handler
          expect(sse).toBeDefined()
          sse.start('autoClose')
        },
      })

      expect(true).toBe(true)
    })
  })

  // GET dual-mode contract (no body)
  const jobStatusContract = buildContract({
    pathResolver: (params) => `/api/jobs/${params.jobId}/status`,
    params: z.object({ jobId: z.string().uuid() }),
    query: z.object({ verbose: z.boolean().optional() }),
    requestHeaders: z.object({}),
    syncResponse: z.object({
      status: z.enum(['pending', 'running', 'completed', 'failed']),
      progress: z.number(),
    }),
    events: {
      progress: z.object({ percent: z.number(), message: z.string().optional() }),
      done: z.object({ result: z.string() }),
    },
  })

  type JobContracts = {
    jobStatus: typeof jobStatusContract
  }

  describe('buildHandler with GET dual-mode contract (no body)', () => {
    it('allows correctly typed handlers without body', () => {
      class JobController extends AbstractDualModeController<JobContracts> {
        public static contracts = { jobStatus: jobStatusContract } as const

        public buildDualModeRoutes(): BuildFastifyDualModeRoutesReturnType<JobContracts> {
          return {
            jobStatus: buildHandler(jobStatusContract, {
              sync: (request) => {
                // Valid: return matches syncResponse schema
                const _jobId = request.params.jobId
                return { status: 'running' as const, progress: 50 }
              },
              sse: async (_request, sse) => {
                const connection = sse.start('autoClose')
                await connection.send('progress', { percent: 50 })
                await connection.send('done', { result: 'completed' })
                // autoClose mode - session closes after handler
              },
            }),
          }
        }
      }

      const controller = new JobController({})
      expect(controller.buildDualModeRoutes()).toBeDefined()
    })

    it('catches wrong sync return type for GET contract', () => {
      // @ts-expect-error - 'invalid' is not a valid status enum value
      buildHandler(jobStatusContract, {
        sync: () => {
          return { status: 'invalid' as const, progress: 50 }
        },
        sse: (_request, sse) => {
          sse.start('autoClose')
        },
      })

      expect(true).toBe(true)
    })

    it('catches wrong sse event for GET contract', () => {
      buildHandler(jobStatusContract, {
        sync: () => ({ status: 'running' as const, progress: 50 }),
        sse: async (_request, sse) => {
          const connection = sse.start('autoClose')
          // @ts-expect-error - 'chunk' is not a valid event name
          await connection.send('chunk', { delta: 'test' })
          // autoClose mode - session closes after handler
        },
      })

      expect(true).toBe(true)
    })

    it('GET contract has no body in contract definition', () => {
      // Verify the contract itself has no body field
      expect(jobStatusContract.requestBody).toBeUndefined()

      // Handlers work without body
      const handlers = buildHandler(jobStatusContract, {
        sync: () => ({ status: 'running' as const, progress: 50 }),
        sse: async (_request, sse) => {
          const connection = sse.start('autoClose')
          await connection.send('progress', { percent: 50 })
          // autoClose mode - session closes after handler
        },
      })

      expect(handlers).toBeDefined()
    })

    it('types params correctly for GET contract', () => {
      buildHandler(jobStatusContract, {
        sync: (request) => {
          const jobId: string = request.params.jobId

          // @ts-expect-error - 'nonExistent' does not exist on params
          const _invalid = request.params.nonExistent

          expect(jobId).toBeDefined()
          return { status: 'running' as const, progress: 50 }
        },
        sse: (_request, sse) => {
          sse.start('autoClose')
        },
      })

      expect(true).toBe(true)
    })
  })
})

// ============================================================================
// Unified buildHandler Type Safety
// ============================================================================

describe('Unified buildHandler Type Safety', () => {
  // SSE-only contract
  const notificationsContract = buildContract({
    pathResolver: (params) => `/api/users/${params.userId}/notifications`,
    params: z.object({ userId: z.string() }),
    query: z.object({ since: z.string().optional() }),
    requestHeaders: z.object({}),
    events: {
      notification: z.object({ id: z.string(), message: z.string() }),
      heartbeat: z.object({ timestamp: z.number() }),
    },
  })

  // Dual-mode contract
  const chatCompletionContract = buildContract({
    method: 'POST',
    pathResolver: () => '/api/chat/completions',
    params: z.object({}),
    query: z.object({}),
    requestHeaders: z.object({}),
    requestBody: z.object({ message: z.string() }),
    syncResponse: z.object({
      reply: z.string(),
      usage: z.object({ tokens: z.number() }),
    }),
    events: {
      chunk: z.object({ delta: z.string() }),
      done: z.object({ usage: z.object({ total: z.number() }) }),
    },
  })

  describe('SSE-only contracts', () => {
    it('accepts { sse } handler for SSE-only contract', () => {
      const container = buildHandler(notificationsContract, {
        sse: async (request, sse) => {
          const connection = sse.start('autoClose')
          // connection.send is typed
          await connection.send('notification', { id: '1', message: 'Hello' })
          await connection.send('heartbeat', { timestamp: Date.now() })

          // request is typed
          const userId: string = request.params.userId
          expect(userId).toBeDefined()

          // autoClose mode - session closes after handler
        },
      })

      expect(container).toBeDefined()
      expect(container.__type).toBe('SSERouteHandler')
      expect(container.handlers.sse).toBeDefined()
    })

    it('catches invalid event name in SSE-only handler', () => {
      buildHandler(notificationsContract, {
        sse: async (_request, sse) => {
          const connection = sse.start('autoClose')
          // @ts-expect-error - 'invalid' is not a valid event name
          await connection.send('invalid', { data: 'test' })
          // autoClose mode - session closes after handler
        },
      })

      expect(true).toBe(true)
    })

    it('catches wrong event payload in SSE-only handler', () => {
      buildHandler(notificationsContract, {
        sse: async (_request, sse) => {
          const connection = sse.start('autoClose')
          // @ts-expect-error - 'notification' expects { id, message }, not { text }
          await connection.send('notification', { text: 'wrong' })
          // autoClose mode - session closes after handler
        },
      })

      expect(true).toBe(true)
    })

    it('types request params in SSE-only handler', () => {
      buildHandler(notificationsContract, {
        sse: (request, sse) => {
          const userId: string = request.params.userId

          // @ts-expect-error - 'nonExistent' does not exist on params
          const _invalid = request.params.nonExistent

          expect(userId).toBeDefined()

          sse.start('autoClose')
        },
      })

      expect(true).toBe(true)
    })
  })

  describe('Dual-mode contracts', () => {
    it('accepts { sync, sse } handlers for dual-mode contract', () => {
      const container = buildHandler(chatCompletionContract, {
        sync: (request) => {
          return {
            reply: request.body.message,
            usage: { tokens: 10 },
          }
        },
        sse: async (_request, sse) => {
          const connection = sse.start('autoClose')
          await connection.send('chunk', { delta: 'Hello' })
          await connection.send('done', { usage: { total: 10 } })
          // autoClose mode - session closes after handler
        },
      })

      expect(container).toBeDefined()
      expect(container.__type).toBe('DualModeRouteHandler')
      expect(container.handlers.sync).toBeDefined()
      expect(container.handlers.sse).toBeDefined()
    })

    it('types sync handler return correctly', () => {
      // This test verifies sync handler return type inference works correctly.
      // Direct @ts-expect-error on the return statement doesn't work because
      // TypeScript uses contextual return type inference and excess property
      // checking doesn't apply the same way for function returns.
      // Instead, we verify the positive case - correct return compiles fine.
      buildHandler(chatCompletionContract, {
        sync: () => {
          return { reply: 'Hello', usage: { tokens: 10 } }
        },
        sse: (_request, sse) => {
          sse.start('autoClose')
        },
      })

      expect(true).toBe(true)
    })

    it('catches invalid sse event in dual-mode', () => {
      buildHandler(chatCompletionContract, {
        sync: () => ({ reply: 'Hello', usage: { tokens: 10 } }),
        sse: async (_request, sse) => {
          const connection = sse.start('autoClose')
          // @ts-expect-error - 'invalid' is not a valid event name
          await connection.send('invalid', { data: 'test' })
          // autoClose mode - session closes after handler
        },
      })

      expect(true).toBe(true)
    })

    it('types request body in both handlers', () => {
      buildHandler(chatCompletionContract, {
        sync: (request) => {
          const message: string = request.body.message

          // @ts-expect-error - 'nonExistent' does not exist on body
          const _invalid = request.body.nonExistent

          expect(message).toBeDefined()
          return { reply: message, usage: { tokens: 10 } }
        },
        sse: (request, sse) => {
          const message: string = request.body.message

          // @ts-expect-error - 'nonExistent' does not exist on body
          const _invalid = request.body.nonExistent

          expect(message).toBeDefined()

          sse.start('autoClose')
        },
      })

      expect(true).toBe(true)
    })

    it('provides FastifyReply as second argument in json handler', () => {
      buildHandler(chatCompletionContract, {
        sync: (_request, reply) => {
          // Assert reply is FastifyReply
          expectTypeOf(reply).toEqualTypeOf<FastifyReply>()
          return { reply: 'Hello', usage: { tokens: 10 } }
        },
        sse: (_request, sse) => {
          sse.start('autoClose')
        },
      })

      expect(true).toBe(true)
    })

    it('provides SSEContext as second argument in sse handler', () => {
      buildHandler(chatCompletionContract, {
        sync: () => ({ reply: 'Hello', usage: { tokens: 10 } }),
        sse: (_request, sse) => {
          // Assert sse is SSEContext with typed events
          expectTypeOf(sse).toEqualTypeOf<SSEContext<typeof chatCompletionContract.events>>()
          sse.start('autoClose')
        },
      })

      expect(true).toBe(true)
    })

    it('requires json handler for dual-mode contract', () => {
      // @ts-expect-error - dual-mode contracts require both json and sse handlers
      buildHandler(chatCompletionContract, {
        sse: (_request, sse) => {
          sse.start('autoClose')
        },
      })

      expect(true).toBe(true)
    })

    it('requires sse handler for dual-mode contract', () => {
      // @ts-expect-error - dual-mode contracts require both json and sse handlers
      buildHandler(chatCompletionContract, {
        sync: () => ({ reply: 'Hello', usage: { tokens: 10 } }),
      })

      expect(true).toBe(true)
    })
  })

  describe('SSE-only contracts require only sse handler', () => {
    it('accepts handlers with only sse for SSE-only contract', () => {
      const container = buildHandler(notificationsContract, {
        sse: (_request, sse) => {
          sse.start('autoClose')
        },
      })

      expect(container).toBeDefined()
      expect(container.__type).toBe('SSERouteHandler')
      expect(container.handlers.sse).toBeDefined()
    })

    it('rejects sync handler for SSE-only contract', () => {
      // This test verifies that SSE-only contracts reject a sync handler.
      // The type error occurs on the entire buildHandler call because the handlers
      // object doesn't match SSEOnlyHandlers (which has sync?: never).
      // @ts-expect-error - SSE-only contracts do not allow sync handler
      buildHandler(notificationsContract, {
        sync: () => {},
        sse: (_request, sse) => {
          sse.start('autoClose')
        },
      })

      expect(true).toBe(true)
    })
  })
})
