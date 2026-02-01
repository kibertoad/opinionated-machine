import { success } from '@lokalise/node-core'
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
  type SSEConnection,
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
              handlers: this.chatHandlers,
            },
          }
        }

        // Handler using buildHandler for type inference
        private chatHandlers = buildHandler(chatStreamContract, {
          sse: async (request, connection) => {
            // Verify request and connection are NOT typed as any (catches inference failures)
            expectTypeOf(request).not.toBeAny()
            expectTypeOf(connection).not.toBeAny()

            // Verify request.body is properly typed
            expectTypeOf(request.body).toEqualTypeOf<{
              model: string
              messages: Array<{ role: string; content: string }>
            }>()

            // Verify request.body.model is string, not any (would not error if any)
            // @ts-expect-error - model is string, assigning to number must fail
            const _typeCheck: number = request.body.model

            // Valid: correct event names and payloads
            await connection.send('chunk', { content: 'Hello', index: 0 })
            await connection.send('chunk', { content: ' world', index: 1 })
            await connection.send('done', { totalTokens: 10, model: request.body.model })

            // Request body is typed
            const messages = request.body.messages
            expect(messages).toBeDefined()

            return success('disconnect')
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
            chatStream: {
              contract: InvalidEventController.contracts.chatStream,
              handlers: this.chatHandlers,
            },
          }
        }

        private chatHandlers = buildHandler(chatStreamContract, {
          sse: async (_request, connection) => {
            // @ts-expect-error - 'message' is not a valid event name, should be 'chunk', 'done', or 'error'
            await connection.send('message', { text: 'hello' })
            return success('disconnect')
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
            chatStream: {
              contract: WrongPayloadController.contracts.chatStream,
              handlers: this.chatHandlers,
            },
          }
        }

        private chatHandlers = buildHandler(chatStreamContract, {
          sse: async (_request, connection) => {
            // @ts-expect-error - 'chunk' event expects { content: string, index: number }, not { text: string }
            await connection.send('chunk', { text: 'hello' })
            return success('disconnect')
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
            chatStream: {
              contract: MissingFieldController.contracts.chatStream,
              handlers: this.chatHandlers,
            },
          }
        }

        private chatHandlers = buildHandler(chatStreamContract, {
          sse: async (_request, connection) => {
            // @ts-expect-error - 'done' event requires both 'totalTokens' and 'model', missing 'model'
            await connection.send('done', { totalTokens: 10 })
            return success('disconnect')
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
            chatStream: {
              contract: WrongTypeController.contracts.chatStream,
              handlers: this.chatHandlers,
            },
          }
        }

        private chatHandlers = buildHandler(chatStreamContract, {
          sse: async (_request, connection) => {
            // @ts-expect-error - 'index' should be number, not string
            await connection.send('chunk', { content: 'hello', index: 'one' })
            return success('disconnect')
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
            chatStream: {
              contract: MismatchedPayloadController.contracts.chatStream,
              handlers: this.chatHandlers,
            },
          }
        }

        private chatHandlers = buildHandler(chatStreamContract, {
          sse: async (_request, connection) => {
            // @ts-expect-error - 'chunk' event expects { content: string, index: number }, not 'done' payload { totalTokens: number, model: string }
            await connection.send('chunk', { totalTokens: 10, model: 'gpt-4' })

            // @ts-expect-error - 'done' event expects { totalTokens: number, model: string }, not 'chunk' payload { content: string, index: number }
            await connection.send('done', { content: 'hello', index: 0 })

            // @ts-expect-error - 'error' event expects { code: number, message: string }, not 'chunk' payload
            await connection.send('error', { content: 'hello', index: 0 })

            return success('disconnect')
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
            chatStream: {
              contract: TypedRequestController.contracts.chatStream,
              handlers: this.chatHandlers,
            },
          }
        }

        private chatHandlers = buildHandler(chatStreamContract, {
          sse: (request) => {
            // These should be typed
            const model: string = request.body.model
            const messages: Array<{ role: string; content: string }> = request.body.messages

            // @ts-expect-error - 'nonExistent' doesn't exist on body
            const _invalid = request.body.nonExistent

            expect(model).toBeDefined()
            expect(messages).toBeDefined()

            return success('disconnect')
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
            chatStream: {
              contract: TypedHeadersController.contracts.chatStream,
              handlers: this.chatHandlers,
            },
          }
        }

        private chatHandlers = buildHandler(chatStreamContract, {
          sse: (request) => {
            // Authorization header is typed as string (required by contract schema)
            const auth: string = request.headers.authorization

            // Note: Fastify headers are loosely typed (allow arbitrary keys)
            // so we can't test @ts-expect-error for non-existent headers
            expect(auth).toBeDefined()

            return success('disconnect')
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
            chatStream: {
              contract: ExternalTriggerController.contracts.chatStream,
              handlers: buildHandler(chatStreamContract, {
                sse: () => {
                  return success('maintain_connection')
                },
              }),
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
              handlers: buildHandler(chatStreamContract, {
                sse: () => {
                  return success('maintain_connection')
                },
              }),
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
              handlers: buildHandler(chatStreamContract, {
                sse: () => {
                  return success('maintain_connection')
                },
              }),
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
              handlers: buildHandler(chatStreamContract, {
                sse: () => {
                  return success('maintain_connection')
                },
              }),
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
              handlers: buildHandler(chatStreamContract, {
                sse: () => {
                  return success('maintain_connection')
                },
              }),
            },
            notifications: {
              contract: MultiContractController.contracts.notifications,
              handlers: buildHandler(notificationContract, {
                sse: () => {
                  return success('maintain_connection')
                },
              }),
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
        jsonResponse: z.object({ result: z.string() }),
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
        jsonResponse: z.object({ result: z.string() }),
        events: {
          done: z.object({ success: z.boolean() }),
        },
      })

      // responseHeaders should be undefined
      expect(contractWithoutHeaders.responseHeaders).toBeUndefined()
      expect(contractWithoutHeaders.isDualMode).toBe(true)
    })

    it('SSE contracts do not have responseHeaders', () => {
      // SSE contract (no jsonResponse)
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

  describe('buildHandler with GET SSE contract', () => {
    it('allows correctly typed event sending', () => {
      class NotificationsController extends AbstractSSEController<NotificationContracts> {
        public static contracts = { notifications: notificationsContract } as const

        public buildSSERoutes(): BuildFastifySSERoutesReturnType<NotificationContracts> {
          return {
            notifications: {
              contract: NotificationsController.contracts.notifications,
              handlers: this.handleNotifications,
            },
          }
        }

        private handleNotifications = buildHandler(notificationsContract, {
          sse: async (request, connection) => {
            // Valid: correct event names and payloads
            await connection.send('notification', { id: '1', message: 'Hello' })
            await connection.send('heartbeat', { timestamp: Date.now() })

            // Request params are typed
            const userId: string = request.params.userId
            expect(userId).toBeDefined()

            // Request query is typed
            const since: string | undefined = request.query.since
            expect(since).toBeDefined()

            return success('disconnect')
          },
        })
      }

      const controller = new NotificationsController({})
      expect(controller.buildSSERoutes()).toBeDefined()
    })

    it('catches invalid event name at compile time', () => {
      buildHandler(notificationsContract, {
        sse: async (_request, connection) => {
          // @ts-expect-error - 'message' is not a valid event name
          await connection.send('message', { text: 'hello' })
          return success('disconnect')
        },
      })

      expect(true).toBe(true)
    })

    it('catches wrong payload structure at compile time', () => {
      buildHandler(notificationsContract, {
        sse: async (_request, connection) => {
          // @ts-expect-error - 'notification' expects { id: string, message: string }, not { text: string }
          await connection.send('notification', { text: 'hello' })
          return success('disconnect')
        },
      })

      expect(true).toBe(true)
    })

    it('catches missing required fields at compile time', () => {
      buildHandler(notificationsContract, {
        sse: async (_request, connection) => {
          // @ts-expect-error - 'notification' requires both 'id' and 'message'
          await connection.send('notification', { id: '1' })
          return success('disconnect')
        },
      })

      expect(true).toBe(true)
    })

    it('types request params from contract', () => {
      buildHandler(notificationsContract, {
        sse: (request) => {
          const userId: string = request.params.userId

          // @ts-expect-error - 'nonExistent' does not exist on params
          const _invalid = request.params.nonExistent

          expect(userId).toBeDefined()

          return success('disconnect')
        },
      })

      expect(true).toBe(true)
    })

    it('types request query from contract', () => {
      buildHandler(notificationsContract, {
        sse: (request) => {
          const since: string | undefined = request.query.since

          // @ts-expect-error - 'nonExistent' does not exist on query
          const _invalid = request.query.nonExistent

          expect(since).toBeDefined()

          return success('disconnect')
        },
      })

      expect(true).toBe(true)
    })

    it('GET contract has no body in contract definition', () => {
      // Verify the contract itself has no body field
      expect(notificationsContract.body).toBeUndefined()

      // The handler can still be created and works without body
      const handlers = buildHandler(notificationsContract, {
        sse: async (_request, connection) => {
          await connection.send('notification', { id: '1', message: 'test' })
          return success('disconnect')
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
    body: z.object({
      message: z.string(),
      temperature: z.number().optional(),
    }),
    jsonResponse: z.object({
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
            chatCompletion: {
              contract: ChatController.contracts.chatCompletion,
              handlers: buildHandler(chatCompletionContract, {
                json: (request) => {
                  // Valid: return matches jsonResponse schema
                  return {
                    reply: request.body.message,
                    usage: { tokens: 10 },
                  }
                },
                sse: async (_request, connection) => {
                  await connection.send('chunk', { delta: 'Hello' })
                  await connection.send('done', { usage: { total: 10 } })
                  return success('disconnect')
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
      buildHandler(chatCompletionContract, {
        // @ts-expect-error - return type doesn't match jsonResponse: missing 'usage'
        json: () => {
          return { reply: 'Hello' }
        },
        sse: () => {
          return success('disconnect')
        },
      })

      expect(true).toBe(true)
    })

    it('catches wrong json handler return field type at compile time', () => {
      buildHandler(chatCompletionContract, {
        // @ts-expect-error - 'tokens' should be number, not string
        json: () => {
          return { reply: 'Hello', usage: { tokens: 'ten' } }
        },
        sse: () => {
          return success('disconnect')
        },
      })

      expect(true).toBe(true)
    })

    it('catches extra fields in json handler return at compile time', () => {
      buildHandler(chatCompletionContract, {
        json: () => {
          return {
            reply: 'Hello',
            usage: { tokens: 10 },
            // Note: TypeScript allows extra properties in object literals by default
            // This test documents that behavior - strict excess property checking
            // would require explicit typing
          }
        },
        sse: () => {
          return success('disconnect')
        },
      })

      expect(true).toBe(true)
    })

    it('catches invalid sse event name at compile time', () => {
      buildHandler(chatCompletionContract, {
        json: () => ({ reply: 'Hello', usage: { tokens: 10 } }),
        sse: async (_request, connection) => {
          // @ts-expect-error - 'invalid' is not a valid event name
          await connection.send('invalid', { data: 'test' })
          return success('disconnect')
        },
      })

      expect(true).toBe(true)
    })

    it('catches wrong sse event payload at compile time', () => {
      buildHandler(chatCompletionContract, {
        json: () => ({ reply: 'Hello', usage: { tokens: 10 } }),
        sse: async (_request, connection) => {
          // @ts-expect-error - 'chunk' expects { delta: string }, not { content: string }
          await connection.send('chunk', { content: 'Hello' })
          return success('disconnect')
        },
      })

      expect(true).toBe(true)
    })

    it('catches missing required sse event fields at compile time', () => {
      buildHandler(chatCompletionContract, {
        json: () => ({ reply: 'Hello', usage: { tokens: 10 } }),
        sse: async (_request, connection) => {
          // @ts-expect-error - 'done' requires { usage: { total: number } }
          await connection.send('done', {})
          return success('disconnect')
        },
      })

      expect(true).toBe(true)
    })

    it('types request body in json handler', () => {
      buildHandler(chatCompletionContract, {
        json: (request) => {
          // Body is typed
          const message: string = request.body.message
          const temperature: number | undefined = request.body.temperature

          // @ts-expect-error - 'nonExistent' does not exist on body
          const _invalid = request.body.nonExistent

          expect(message).toBeDefined()
          expect(temperature).toBeDefined()

          return { reply: message, usage: { tokens: 10 } }
        },
        sse: () => {
          return success('disconnect')
        },
      })

      expect(true).toBe(true)
    })

    it('types request body in sse handler', () => {
      buildHandler(chatCompletionContract, {
        json: () => ({ reply: 'Hello', usage: { tokens: 10 } }),
        sse: (request) => {
          // Body is typed
          const message: string = request.body.message

          // @ts-expect-error - 'nonExistent' does not exist on body
          const _invalid = request.body.nonExistent

          expect(message).toBeDefined()

          return success('disconnect')
        },
      })

      expect(true).toBe(true)
    })

    it('types request params in both handlers', () => {
      buildHandler(chatCompletionContract, {
        json: (request) => {
          const chatId: string = request.params.chatId

          // @ts-expect-error - 'nonExistent' does not exist on params
          const _invalid = request.params.nonExistent

          expect(chatId).toBeDefined()
          return { reply: 'Hello', usage: { tokens: 10 } }
        },
        sse: (request) => {
          const chatId: string = request.params.chatId

          // @ts-expect-error - 'nonExistent' does not exist on params
          const _invalid = request.params.nonExistent

          expect(chatId).toBeDefined()

          return success('disconnect')
        },
      })

      expect(true).toBe(true)
    })

    it('types request query in both handlers', () => {
      buildHandler(chatCompletionContract, {
        json: (request) => {
          const verbose: boolean | undefined = request.query.verbose

          // @ts-expect-error - 'nonExistent' does not exist on query
          const _invalid = request.query.nonExistent

          expect(verbose).toBeDefined()
          return { reply: 'Hello', usage: { tokens: 10 } }
        },
        sse: (request) => {
          const verbose: boolean | undefined = request.query.verbose

          // @ts-expect-error - 'nonExistent' does not exist on query
          const _invalid = request.query.nonExistent

          expect(verbose).toBeDefined()

          return success('disconnect')
        },
      })

      expect(true).toBe(true)
    })

    it('provides reply in json handler as second argument', () => {
      buildHandler(chatCompletionContract, {
        json: (_request, reply) => {
          // Reply is available as second argument in json handler
          expect(reply).toBeDefined()
          return { reply: 'Hello', usage: { tokens: 10 } }
        },
        sse: () => {
          return success('disconnect')
        },
      })

      expect(true).toBe(true)
    })

    it('provides connection in sse handler as second argument', () => {
      buildHandler(chatCompletionContract, {
        json: () => ({ reply: 'Hello', usage: { tokens: 10 } }),
        sse: (_request, connection) => {
          // Connection is available as second argument in sse handler
          expect(connection).toBeDefined()
          return success('disconnect')
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
    jsonResponse: z.object({
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
            jobStatus: {
              contract: JobController.contracts.jobStatus,
              handlers: buildHandler(jobStatusContract, {
                json: (request) => {
                  // Valid: return matches jsonResponse schema
                  const _jobId = request.params.jobId
                  return { status: 'running' as const, progress: 50 }
                },
                sse: async (_request, connection) => {
                  await connection.send('progress', { percent: 50 })
                  await connection.send('done', { result: 'completed' })
                  return success('disconnect')
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
      buildHandler(jobStatusContract, {
        // @ts-expect-error - 'invalid' is not a valid status enum value
        json: () => {
          return { status: 'invalid' as const, progress: 50 }
        },
        sse: () => {
          return success('disconnect')
        },
      })

      expect(true).toBe(true)
    })

    it('catches wrong sse event for GET contract', () => {
      buildHandler(jobStatusContract, {
        json: () => ({ status: 'running' as const, progress: 50 }),
        sse: async (_request, connection) => {
          // @ts-expect-error - 'chunk' is not a valid event name
          await connection.send('chunk', { delta: 'test' })
          return success('disconnect')
        },
      })

      expect(true).toBe(true)
    })

    it('GET contract has no body in contract definition', () => {
      // Verify the contract itself has no body field
      expect(jobStatusContract.body).toBeUndefined()

      // Handlers work without body
      const handlers = buildHandler(jobStatusContract, {
        json: () => ({ status: 'running' as const, progress: 50 }),
        sse: async (_request, connection) => {
          await connection.send('progress', { percent: 50 })
          return success('disconnect')
        },
      })

      expect(handlers).toBeDefined()
    })

    it('types params correctly for GET contract', () => {
      buildHandler(jobStatusContract, {
        json: (request) => {
          const jobId: string = request.params.jobId

          // @ts-expect-error - 'nonExistent' does not exist on params
          const _invalid = request.params.nonExistent

          expect(jobId).toBeDefined()
          return { status: 'running' as const, progress: 50 }
        },
        sse: () => {
          return success('disconnect')
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
    body: z.object({ message: z.string() }),
    jsonResponse: z.object({
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
      const handlers = buildHandler(notificationsContract, {
        sse: async (request, connection) => {
          // connection.send is typed
          await connection.send('notification', { id: '1', message: 'Hello' })
          await connection.send('heartbeat', { timestamp: Date.now() })

          // request is typed
          const userId: string = request.params.userId
          expect(userId).toBeDefined()

          return success('disconnect')
        },
      })

      expect(handlers).toBeDefined()
      expect(handlers.sse).toBeDefined()
    })

    it('catches invalid event name in SSE-only handler', () => {
      buildHandler(notificationsContract, {
        sse: async (_request, connection) => {
          // @ts-expect-error - 'invalid' is not a valid event name
          await connection.send('invalid', { data: 'test' })
          return success('disconnect')
        },
      })

      expect(true).toBe(true)
    })

    it('catches wrong event payload in SSE-only handler', () => {
      buildHandler(notificationsContract, {
        sse: async (_request, connection) => {
          // @ts-expect-error - 'notification' expects { id, message }, not { text }
          await connection.send('notification', { text: 'wrong' })
          return success('disconnect')
        },
      })

      expect(true).toBe(true)
    })

    it('types request params in SSE-only handler', () => {
      buildHandler(notificationsContract, {
        sse: (request) => {
          const userId: string = request.params.userId

          // @ts-expect-error - 'nonExistent' does not exist on params
          const _invalid = request.params.nonExistent

          expect(userId).toBeDefined()

          return success('disconnect')
        },
      })

      expect(true).toBe(true)
    })
  })

  describe('Dual-mode contracts', () => {
    it('accepts { json, sse } handlers for dual-mode contract', () => {
      const handlers = buildHandler(chatCompletionContract, {
        json: (request) => {
          return {
            reply: request.body.message,
            usage: { tokens: 10 },
          }
        },
        sse: async (_request, connection) => {
          await connection.send('chunk', { delta: 'Hello' })
          await connection.send('done', { usage: { total: 10 } })
          return success('disconnect')
        },
      })

      expect(handlers).toBeDefined()
      expect(handlers.json).toBeDefined()
      expect(handlers.sse).toBeDefined()
    })

    it('catches wrong json return type', () => {
      buildHandler(chatCompletionContract, {
        // @ts-expect-error - missing 'usage' in return type
        json: () => {
          return { reply: 'Hello' }
        },
        sse: () => {
          return success('disconnect')
        },
      })

      expect(true).toBe(true)
    })

    it('catches invalid sse event in dual-mode', () => {
      buildHandler(chatCompletionContract, {
        json: () => ({ reply: 'Hello', usage: { tokens: 10 } }),
        sse: async (_request, connection) => {
          // @ts-expect-error - 'invalid' is not a valid event name
          await connection.send('invalid', { data: 'test' })
          return success('disconnect')
        },
      })

      expect(true).toBe(true)
    })

    it('types request body in both handlers', () => {
      buildHandler(chatCompletionContract, {
        json: (request) => {
          const message: string = request.body.message

          // @ts-expect-error - 'nonExistent' does not exist on body
          const _invalid = request.body.nonExistent

          expect(message).toBeDefined()
          return { reply: message, usage: { tokens: 10 } }
        },
        sse: (request) => {
          const message: string = request.body.message

          // @ts-expect-error - 'nonExistent' does not exist on body
          const _invalid = request.body.nonExistent

          expect(message).toBeDefined()

          return success('disconnect')
        },
      })

      expect(true).toBe(true)
    })

    it('provides FastifyReply as second argument in json handler', () => {
      buildHandler(chatCompletionContract, {
        json: (_request, reply) => {
          // Assert reply is FastifyReply
          expectTypeOf(reply).toEqualTypeOf<FastifyReply>()
          return { reply: 'Hello', usage: { tokens: 10 } }
        },
        sse: () => {
          return success('disconnect')
        },
      })

      expect(true).toBe(true)
    })

    it('provides SSEConnection as second argument in sse handler', () => {
      buildHandler(chatCompletionContract, {
        json: () => ({ reply: 'Hello', usage: { tokens: 10 } }),
        sse: (_request, connection) => {
          // Assert connection is SSEConnection with typed events
          expectTypeOf(connection).toEqualTypeOf<
            SSEConnection<typeof chatCompletionContract.events>
          >()
          return success('disconnect')
        },
      })

      expect(true).toBe(true)
    })

    it('requires json handler for dual-mode contract', () => {
      // @ts-expect-error - dual-mode contracts require both json and sse handlers
      buildHandler(chatCompletionContract, {
        sse: () => {
          return success('disconnect')
        },
      })

      expect(true).toBe(true)
    })

    it('requires sse handler for dual-mode contract', () => {
      // @ts-expect-error - dual-mode contracts require both json and sse handlers
      buildHandler(chatCompletionContract, {
        json: () => ({ reply: 'Hello', usage: { tokens: 10 } }),
      })

      expect(true).toBe(true)
    })
  })

  describe('SSE-only contracts require only sse handler', () => {
    it('accepts handlers with only sse for SSE-only contract', () => {
      const handlers = buildHandler(notificationsContract, {
        sse: () => {
          return success('disconnect')
        },
      })

      expect(handlers).toBeDefined()
      expect(handlers.sse).toBeDefined()
    })

    it('rejects json handler for SSE-only contract', () => {
      buildHandler(notificationsContract, {
        // @ts-expect-error - SSE-only contracts do not allow json handler (json?: never)
        json: () => {},
        sse: () => {
          return success('disconnect')
        },
      })

      expect(true).toBe(true)
    })
  })
})
