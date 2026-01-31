import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import {
  AbstractSSEController,
  type BuildFastifySSERoutesReturnType,
  buildFastifySSEHandler,
  buildPayloadSSEContract,
  buildSSEContract,
} from '../../index.js'

/**
 * Type safety tests for SSE controller implementations.
 *
 * These tests verify that TypeScript catches type errors in realistic
 * controller implementations - the way users actually write code.
 */

// Define a realistic contract like users would
const chatStreamContract = buildPayloadSSEContract({
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
      const notificationContract = buildSSEContract({
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
