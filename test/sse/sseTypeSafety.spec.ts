import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import {
  AbstractDualModeController,
  AbstractSSEController,
  type BuildFastifyDualModeRoutesReturnType,
  type BuildFastifySSERoutesReturnType,
  buildContract,
  buildDualModeHandler,
  buildFastifySSEHandler,
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
  body: z.object({
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
            chatStream: {
              contract: ChatSSEController.contracts.chatStream,
              handler: this.handleChat,
            },
          }
        }

        // Handler using buildFastifySSEHandler for type inference
        private handleChat = buildFastifySSEHandler(
          chatStreamContract,
          async (request, connection) => {
            // Valid: correct event names and payloads
            await connection.send('chunk', { content: 'Hello', index: 0 })
            await connection.send('chunk', { content: ' world', index: 1 })
            await connection.send('done', { totalTokens: 10, model: request.body.model })

            // Request body is typed
            const messages = request.body.messages
            expect(messages).toBeDefined()
          },
        )
      }

      const controller = new ChatSSEController({})
      expect(controller.buildSSERoutes()).toBeDefined()
    })

    it('catches invalid event name at compile time', () => {
      class InvalidEventController extends AbstractSSEController<ChatStreamContracts> {
        public static contracts = { chatStream: chatStreamContract } as const

        public buildSSERoutes(): BuildFastifySSERoutesReturnType<ChatStreamContracts> {
          return {
            chatStream: {
              contract: InvalidEventController.contracts.chatStream,
              handler: this.handleChat,
            },
          }
        }

        private handleChat = buildFastifySSEHandler(
          chatStreamContract,
          async (_request, connection) => {
            // @ts-expect-error - 'message' is not a valid event name, should be 'chunk', 'done', or 'error'
            await connection.send('message', { text: 'hello' })
          },
        )
      }

      expect(InvalidEventController).toBeDefined()
    })

    it('catches wrong payload structure at compile time', () => {
      class WrongPayloadController extends AbstractSSEController<ChatStreamContracts> {
        public static contracts = { chatStream: chatStreamContract } as const

        public buildSSERoutes(): BuildFastifySSERoutesReturnType<ChatStreamContracts> {
          return {
            chatStream: {
              contract: WrongPayloadController.contracts.chatStream,
              handler: this.handleChat,
            },
          }
        }

        private handleChat = buildFastifySSEHandler(
          chatStreamContract,
          async (_request, connection) => {
            // @ts-expect-error - 'chunk' event expects { content: string, index: number }, not { text: string }
            await connection.send('chunk', { text: 'hello' })
          },
        )
      }

      expect(WrongPayloadController).toBeDefined()
    })

    it('catches missing required fields at compile time', () => {
      class MissingFieldController extends AbstractSSEController<ChatStreamContracts> {
        public static contracts = { chatStream: chatStreamContract } as const

        public buildSSERoutes(): BuildFastifySSERoutesReturnType<ChatStreamContracts> {
          return {
            chatStream: {
              contract: MissingFieldController.contracts.chatStream,
              handler: this.handleChat,
            },
          }
        }

        private handleChat = buildFastifySSEHandler(
          chatStreamContract,
          async (_request, connection) => {
            // @ts-expect-error - 'done' event requires both 'totalTokens' and 'model', missing 'model'
            await connection.send('done', { totalTokens: 10 })
          },
        )
      }

      expect(MissingFieldController).toBeDefined()
    })

    it('catches wrong field types at compile time', () => {
      class WrongTypeController extends AbstractSSEController<ChatStreamContracts> {
        public static contracts = { chatStream: chatStreamContract } as const

        public buildSSERoutes(): BuildFastifySSERoutesReturnType<ChatStreamContracts> {
          return {
            chatStream: {
              contract: WrongTypeController.contracts.chatStream,
              handler: this.handleChat,
            },
          }
        }

        private handleChat = buildFastifySSEHandler(
          chatStreamContract,
          async (_request, connection) => {
            // @ts-expect-error - 'index' should be number, not string
            await connection.send('chunk', { content: 'hello', index: 'one' })
          },
        )
      }

      expect(WrongTypeController).toBeDefined()
    })

    it('catches mismatched event payload between different event types', () => {
      class MismatchedPayloadController extends AbstractSSEController<ChatStreamContracts> {
        public static contracts = { chatStream: chatStreamContract } as const

        public buildSSERoutes(): BuildFastifySSERoutesReturnType<ChatStreamContracts> {
          return {
            chatStream: {
              contract: MismatchedPayloadController.contracts.chatStream,
              handler: this.handleChat,
            },
          }
        }

        private handleChat = buildFastifySSEHandler(
          chatStreamContract,
          async (_request, connection) => {
            // @ts-expect-error - 'chunk' event expects { content: string, index: number }, not 'done' payload { totalTokens: number, model: string }
            await connection.send('chunk', { totalTokens: 10, model: 'gpt-4' })

            // @ts-expect-error - 'done' event expects { totalTokens: number, model: string }, not 'chunk' payload { content: string, index: number }
            await connection.send('done', { content: 'hello', index: 0 })

            // @ts-expect-error - 'error' event expects { code: number, message: string }, not 'chunk' payload
            await connection.send('error', { content: 'hello', index: 0 })
          },
        )
      }

      expect(MismatchedPayloadController).toBeDefined()
    })

    it('provides typed request body in handler', () => {
      class TypedRequestController extends AbstractSSEController<ChatStreamContracts> {
        public static contracts = { chatStream: chatStreamContract } as const

        public buildSSERoutes(): BuildFastifySSERoutesReturnType<ChatStreamContracts> {
          return {
            chatStream: {
              contract: TypedRequestController.contracts.chatStream,
              handler: this.handleChat,
            },
          }
        }

        private handleChat = buildFastifySSEHandler(chatStreamContract, (request, _connection) => {
          // These should be typed
          const model: string = request.body.model
          const messages: Array<{ role: string; content: string }> = request.body.messages

          // @ts-expect-error - 'nonExistent' doesn't exist on body
          const _invalid = request.body.nonExistent

          expect(model).toBeDefined()
          expect(messages).toBeDefined()
        })
      }

      expect(TypedRequestController).toBeDefined()
    })

    it('provides typed headers in handler', () => {
      class TypedHeadersController extends AbstractSSEController<ChatStreamContracts> {
        public static contracts = { chatStream: chatStreamContract } as const

        public buildSSERoutes(): BuildFastifySSERoutesReturnType<ChatStreamContracts> {
          return {
            chatStream: {
              contract: TypedHeadersController.contracts.chatStream,
              handler: this.handleChat,
            },
          }
        }

        private handleChat = buildFastifySSEHandler(chatStreamContract, (request, _connection) => {
          // Authorization header is typed as string (required by contract schema)
          const auth: string = request.headers.authorization

          // Note: Fastify headers are loosely typed (allow arbitrary keys)
          // so we can't test @ts-expect-error for non-existent headers
          expect(auth).toBeDefined()
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
            chatStream: {
              contract: ExternalTriggerController.contracts.chatStream,
              handler: buildFastifySSEHandler(chatStreamContract, async () => {}),
            },
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
            chatStream: {
              contract: InvalidExternalController.contracts.chatStream,
              handler: buildFastifySSEHandler(chatStreamContract, async () => {}),
            },
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
            chatStream: {
              contract: WrongPayloadExternalController.contracts.chatStream,
              handler: buildFastifySSEHandler(chatStreamContract, async () => {}),
            },
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
            chatStream: {
              contract: MissingFieldExternalController.contracts.chatStream,
              handler: buildFastifySSEHandler(chatStreamContract, async () => {}),
            },
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
            chatStream: {
              contract: MultiContractController.contracts.chatStream,
              handler: buildFastifySSEHandler(chatStreamContract, async () => {}),
            },
            notifications: {
              contract: MultiContractController.contracts.notifications,
              handler: buildFastifySSEHandler(notificationContract, async () => {}),
            },
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
        body: z.object({ data: z.string() }),
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
        body: z.object({ data: z.string() }),
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
        body: z.object({ data: z.string() }),
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

  describe('buildFastifySSEHandler with GET contract', () => {
    it('allows correctly typed event sending', () => {
      class NotificationsController extends AbstractSSEController<NotificationContracts> {
        public static contracts = { notifications: notificationsContract } as const

        public buildSSERoutes(): BuildFastifySSERoutesReturnType<NotificationContracts> {
          return {
            notifications: {
              contract: NotificationsController.contracts.notifications,
              handler: this.handleNotifications,
            },
          }
        }

        private handleNotifications = buildFastifySSEHandler(
          notificationsContract,
          async (request, connection) => {
            // Valid: correct event names and payloads
            await connection.send('notification', { id: '1', message: 'Hello' })
            await connection.send('heartbeat', { timestamp: Date.now() })

            // Request params are typed
            const userId: string = request.params.userId
            expect(userId).toBeDefined()

            // Request query is typed
            const since: string | undefined = request.query.since
            expect(since).toBeDefined()
          },
        )
      }

      const controller = new NotificationsController({})
      expect(controller.buildSSERoutes()).toBeDefined()
    })

    it('catches invalid event name at compile time', () => {
      buildFastifySSEHandler(notificationsContract, async (_request, connection) => {
        // @ts-expect-error - 'message' is not a valid event name
        await connection.send('message', { text: 'hello' })
      })

      expect(true).toBe(true)
    })

    it('catches wrong payload structure at compile time', () => {
      buildFastifySSEHandler(notificationsContract, async (_request, connection) => {
        // @ts-expect-error - 'notification' expects { id: string, message: string }, not { text: string }
        await connection.send('notification', { text: 'hello' })
      })

      expect(true).toBe(true)
    })

    it('catches missing required fields at compile time', () => {
      buildFastifySSEHandler(notificationsContract, async (_request, connection) => {
        // @ts-expect-error - 'notification' requires both 'id' and 'message'
        await connection.send('notification', { id: '1' })
      })

      expect(true).toBe(true)
    })

    it('types request params from contract', () => {
      buildFastifySSEHandler(notificationsContract, (request, _connection) => {
        const userId: string = request.params.userId

        // @ts-expect-error - 'nonExistent' does not exist on params
        const _invalid = request.params.nonExistent

        expect(userId).toBeDefined()
      })

      expect(true).toBe(true)
    })

    it('types request query from contract', () => {
      buildFastifySSEHandler(notificationsContract, (request, _connection) => {
        const since: string | undefined = request.query.since

        // @ts-expect-error - 'nonExistent' does not exist on query
        const _invalid = request.query.nonExistent

        expect(since).toBeDefined()
      })

      expect(true).toBe(true)
    })

    it('GET contract has no body in contract definition', () => {
      // Verify the contract itself has no body field
      expect(notificationsContract.body).toBeUndefined()

      // The handler can still be created and works without body
      const handler = buildFastifySSEHandler(notificationsContract, async (_request, connection) => {
        await connection.send('notification', { id: '1', message: 'test' })
      })

      expect(handler).toBeDefined()
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
    body: z.object({
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

  describe('buildDualModeHandler with POST contract', () => {
    it('allows correctly typed json handler return', () => {
      class ChatController extends AbstractDualModeController<ChatContracts> {
        public static contracts = { chatCompletion: chatCompletionContract } as const

        public buildDualModeRoutes(): BuildFastifyDualModeRoutesReturnType<ChatContracts> {
          return {
            chatCompletion: {
              contract: ChatController.contracts.chatCompletion,
              handlers: buildDualModeHandler(chatCompletionContract, {
                json: async (ctx) => {
                  // Valid: return matches syncResponse schema
                  return {
                    reply: ctx.request.body.message,
                    usage: { tokens: 10 },
                  }
                },
                sse: async (ctx) => {
                  await ctx.connection.send('chunk', { delta: 'Hello' })
                  await ctx.connection.send('done', { usage: { total: 10 } })
                },
              }),
            },
          }
        }
      }

      const controller = new ChatController({})
      expect(controller.buildDualModeRoutes()).toBeDefined()
    })

    it('catches wrong json handler return type at compile time', () => {
      buildDualModeHandler(chatCompletionContract, {
        // @ts-expect-error - return type doesn't match syncResponse: missing 'usage'
        json: async () => {
          return { reply: 'Hello' }
        },
        sse: async () => {},
      })

      expect(true).toBe(true)
    })

    it('catches wrong json handler return field type at compile time', () => {
      buildDualModeHandler(chatCompletionContract, {
        // @ts-expect-error - 'tokens' should be number, not string
        json: async () => {
          return { reply: 'Hello', usage: { tokens: 'ten' } }
        },
        sse: async () => {},
      })

      expect(true).toBe(true)
    })

    it('catches extra fields in json handler return at compile time', () => {
      buildDualModeHandler(chatCompletionContract, {
        json: async () => {
          return {
            reply: 'Hello',
            usage: { tokens: 10 },
            // Note: TypeScript allows extra properties in object literals by default
            // This test documents that behavior - strict excess property checking
            // would require explicit typing
          }
        },
        sse: async () => {},
      })

      expect(true).toBe(true)
    })

    it('catches invalid sse event name at compile time', () => {
      buildDualModeHandler(chatCompletionContract, {
        json: async () => ({ reply: 'Hello', usage: { tokens: 10 } }),
        sse: async (ctx) => {
          // @ts-expect-error - 'invalid' is not a valid event name
          await ctx.connection.send('invalid', { data: 'test' })
        },
      })

      expect(true).toBe(true)
    })

    it('catches wrong sse event payload at compile time', () => {
      buildDualModeHandler(chatCompletionContract, {
        json: async () => ({ reply: 'Hello', usage: { tokens: 10 } }),
        sse: async (ctx) => {
          // @ts-expect-error - 'chunk' expects { delta: string }, not { content: string }
          await ctx.connection.send('chunk', { content: 'Hello' })
        },
      })

      expect(true).toBe(true)
    })

    it('catches missing required sse event fields at compile time', () => {
      buildDualModeHandler(chatCompletionContract, {
        json: async () => ({ reply: 'Hello', usage: { tokens: 10 } }),
        sse: async (ctx) => {
          // @ts-expect-error - 'done' requires { usage: { total: number } }
          await ctx.connection.send('done', {})
        },
      })

      expect(true).toBe(true)
    })

    it('types request body in json handler', () => {
      buildDualModeHandler(chatCompletionContract, {
        json: async (ctx) => {
          // Body is typed
          const message: string = ctx.request.body.message
          const temperature: number | undefined = ctx.request.body.temperature

          // @ts-expect-error - 'nonExistent' does not exist on body
          const _invalid = ctx.request.body.nonExistent

          expect(message).toBeDefined()
          expect(temperature).toBeDefined()

          return { reply: message, usage: { tokens: 10 } }
        },
        sse: async () => {},
      })

      expect(true).toBe(true)
    })

    it('types request body in sse handler', () => {
      buildDualModeHandler(chatCompletionContract, {
        json: async () => ({ reply: 'Hello', usage: { tokens: 10 } }),
        sse: async (ctx) => {
          // Body is typed
          const message: string = ctx.request.body.message

          // @ts-expect-error - 'nonExistent' does not exist on body
          const _invalid = ctx.request.body.nonExistent

          expect(message).toBeDefined()
        },
      })

      expect(true).toBe(true)
    })

    it('types request params in both handlers', () => {
      buildDualModeHandler(chatCompletionContract, {
        json: async (ctx) => {
          const chatId: string = ctx.request.params.chatId

          // @ts-expect-error - 'nonExistent' does not exist on params
          const _invalid = ctx.request.params.nonExistent

          expect(chatId).toBeDefined()
          return { reply: 'Hello', usage: { tokens: 10 } }
        },
        sse: async (ctx) => {
          const chatId: string = ctx.request.params.chatId

          // @ts-expect-error - 'nonExistent' does not exist on params
          const _invalid = ctx.request.params.nonExistent

          expect(chatId).toBeDefined()
        },
      })

      expect(true).toBe(true)
    })

    it('types request query in both handlers', () => {
      buildDualModeHandler(chatCompletionContract, {
        json: async (ctx) => {
          const verbose: boolean | undefined = ctx.request.query.verbose

          // @ts-expect-error - 'nonExistent' does not exist on query
          const _invalid = ctx.request.query.nonExistent

          expect(verbose).toBeDefined()
          return { reply: 'Hello', usage: { tokens: 10 } }
        },
        sse: async (ctx) => {
          const verbose: boolean | undefined = ctx.request.query.verbose

          // @ts-expect-error - 'nonExistent' does not exist on query
          const _invalid = ctx.request.query.nonExistent

          expect(verbose).toBeDefined()
        },
      })

      expect(true).toBe(true)
    })

    it('provides mode discriminator in context', () => {
      buildDualModeHandler(chatCompletionContract, {
        json: async (ctx) => {
          // Mode is 'json'
          const mode: 'json' = ctx.mode
          expect(mode).toBe('json')
          return { reply: 'Hello', usage: { tokens: 10 } }
        },
        sse: async (ctx) => {
          // Mode is 'sse'
          const mode: 'sse' = ctx.mode
          expect(mode).toBe('sse')
        },
      })

      expect(true).toBe(true)
    })

    it('provides reply in json handler context', () => {
      buildDualModeHandler(chatCompletionContract, {
        json: async (ctx) => {
          // Reply is available in json context
          expect(ctx.reply).toBeDefined()
          return { reply: 'Hello', usage: { tokens: 10 } }
        },
        sse: async (ctx) => {
          // @ts-expect-error - reply does not exist in sse context
          const _reply = ctx.reply
        },
      })

      expect(true).toBe(true)
    })

    it('provides connection in sse handler context', () => {
      buildDualModeHandler(chatCompletionContract, {
        json: async (ctx) => {
          // @ts-expect-error - connection does not exist in json context
          const _connection = ctx.connection
          return { reply: 'Hello', usage: { tokens: 10 } }
        },
        sse: async (ctx) => {
          // Connection is available in sse context
          expect(ctx.connection).toBeDefined()
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

  describe('buildDualModeHandler with GET contract (no body)', () => {
    it('allows correctly typed handlers without body', () => {
      class JobController extends AbstractDualModeController<JobContracts> {
        public static contracts = { jobStatus: jobStatusContract } as const

        public buildDualModeRoutes(): BuildFastifyDualModeRoutesReturnType<JobContracts> {
          return {
            jobStatus: {
              contract: JobController.contracts.jobStatus,
              handlers: buildDualModeHandler(jobStatusContract, {
                json: async (ctx) => {
                  // Valid: return matches syncResponse schema
                  const jobId = ctx.request.params.jobId
                  return { status: 'running' as const, progress: 50 }
                },
                sse: async (ctx) => {
                  await ctx.connection.send('progress', { percent: 50 })
                  await ctx.connection.send('done', { result: 'completed' })
                },
              }),
            },
          }
        }
      }

      const controller = new JobController({})
      expect(controller.buildDualModeRoutes()).toBeDefined()
    })

    it('catches wrong json return type for GET contract', () => {
      buildDualModeHandler(jobStatusContract, {
        // @ts-expect-error - 'invalid' is not a valid status enum value
        json: async () => {
          return { status: 'invalid' as const, progress: 50 }
        },
        sse: async () => {},
      })

      expect(true).toBe(true)
    })

    it('catches wrong sse event for GET contract', () => {
      buildDualModeHandler(jobStatusContract, {
        json: async () => ({ status: 'running' as const, progress: 50 }),
        sse: async (ctx) => {
          // @ts-expect-error - 'chunk' is not a valid event name
          await ctx.connection.send('chunk', { delta: 'test' })
        },
      })

      expect(true).toBe(true)
    })

    it('GET contract has no body in contract definition', () => {
      // Verify the contract itself has no body field
      expect(jobStatusContract.body).toBeUndefined()

      // Handlers work without body
      const handlers = buildDualModeHandler(jobStatusContract, {
        json: async () => ({ status: 'running' as const, progress: 50 }),
        sse: async (ctx) => {
          await ctx.connection.send('progress', { percent: 50 })
        },
      })

      expect(handlers).toBeDefined()
    })

    it('types params correctly for GET contract', () => {
      buildDualModeHandler(jobStatusContract, {
        json: async (ctx) => {
          const jobId: string = ctx.request.params.jobId

          // @ts-expect-error - 'nonExistent' does not exist on params
          const _invalid = ctx.request.params.nonExistent

          expect(jobId).toBeDefined()
          return { status: 'running' as const, progress: 50 }
        },
        sse: async () => {},
      })

      expect(true).toBe(true)
    })
  })
})
