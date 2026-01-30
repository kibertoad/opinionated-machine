import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import {
  AbstractSSEController,
  type BuildSSERoutesReturnType,
  buildPayloadSSERoute,
  buildSSEHandler,
} from '../../index.js'

/**
 * Type safety tests for SSE controller implementations.
 *
 * These tests verify that TypeScript catches type errors in realistic
 * controller implementations - the way users actually write code.
 */

// Define a realistic contract like users would
const chatStreamContract = buildPayloadSSERoute({
  method: 'POST',
  path: '/api/chat/stream' as const,
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

        public buildSSERoutes(): BuildSSERoutesReturnType<ChatStreamContracts> {
          return {
            chatStream: {
              contract: ChatSSEController.contracts.chatStream,
              handler: this.handleChat,
            },
          }
        }

        // Handler using buildSSEHandler for type inference
        private handleChat = buildSSEHandler(
          chatStreamContract,
          async (request, _connection, send) => {
            // Valid: correct event names and payloads
            await send('chunk', { content: 'Hello', index: 0 })
            await send('chunk', { content: ' world', index: 1 })
            await send('done', { totalTokens: 10, model: request.body.model })

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

        public buildSSERoutes(): BuildSSERoutesReturnType<ChatStreamContracts> {
          return {
            chatStream: {
              contract: InvalidEventController.contracts.chatStream,
              handler: this.handleChat,
            },
          }
        }

        private handleChat = buildSSEHandler(
          chatStreamContract,
          async (_request, _connection, send) => {
            // @ts-expect-error - 'message' is not a valid event name, should be 'chunk', 'done', or 'error'
            await send('message', { text: 'hello' })
          },
        )
      }

      expect(InvalidEventController).toBeDefined()
    })

    it('catches wrong payload structure at compile time', () => {
      class WrongPayloadController extends AbstractSSEController<ChatStreamContracts> {
        public static contracts = { chatStream: chatStreamContract } as const

        public buildSSERoutes(): BuildSSERoutesReturnType<ChatStreamContracts> {
          return {
            chatStream: {
              contract: WrongPayloadController.contracts.chatStream,
              handler: this.handleChat,
            },
          }
        }

        private handleChat = buildSSEHandler(
          chatStreamContract,
          async (_request, _connection, send) => {
            // @ts-expect-error - 'chunk' event expects { content: string, index: number }, not { text: string }
            await send('chunk', { text: 'hello' })
          },
        )
      }

      expect(WrongPayloadController).toBeDefined()
    })

    it('catches missing required fields at compile time', () => {
      class MissingFieldController extends AbstractSSEController<ChatStreamContracts> {
        public static contracts = { chatStream: chatStreamContract } as const

        public buildSSERoutes(): BuildSSERoutesReturnType<ChatStreamContracts> {
          return {
            chatStream: {
              contract: MissingFieldController.contracts.chatStream,
              handler: this.handleChat,
            },
          }
        }

        private handleChat = buildSSEHandler(
          chatStreamContract,
          async (_request, _connection, send) => {
            // @ts-expect-error - 'done' event requires both 'totalTokens' and 'model', missing 'model'
            await send('done', { totalTokens: 10 })
          },
        )
      }

      expect(MissingFieldController).toBeDefined()
    })

    it('catches wrong field types at compile time', () => {
      class WrongTypeController extends AbstractSSEController<ChatStreamContracts> {
        public static contracts = { chatStream: chatStreamContract } as const

        public buildSSERoutes(): BuildSSERoutesReturnType<ChatStreamContracts> {
          return {
            chatStream: {
              contract: WrongTypeController.contracts.chatStream,
              handler: this.handleChat,
            },
          }
        }

        private handleChat = buildSSEHandler(
          chatStreamContract,
          async (_request, _connection, send) => {
            // @ts-expect-error - 'index' should be number, not string
            await send('chunk', { content: 'hello', index: 'one' })
          },
        )
      }

      expect(WrongTypeController).toBeDefined()
    })

    it('catches mismatched event payload between different event types', () => {
      class MismatchedPayloadController extends AbstractSSEController<ChatStreamContracts> {
        public static contracts = { chatStream: chatStreamContract } as const

        public buildSSERoutes(): BuildSSERoutesReturnType<ChatStreamContracts> {
          return {
            chatStream: {
              contract: MismatchedPayloadController.contracts.chatStream,
              handler: this.handleChat,
            },
          }
        }

        private handleChat = buildSSEHandler(
          chatStreamContract,
          async (_request, _connection, send) => {
            // @ts-expect-error - 'chunk' event expects { content: string, index: number }, not 'done' payload { totalTokens: number, model: string }
            await send('chunk', { totalTokens: 10, model: 'gpt-4' })

            // @ts-expect-error - 'done' event expects { totalTokens: number, model: string }, not 'chunk' payload { content: string, index: number }
            await send('done', { content: 'hello', index: 0 })

            // @ts-expect-error - 'error' event expects { code: number, message: string }, not 'chunk' payload
            await send('error', { content: 'hello', index: 0 })
          },
        )
      }

      expect(MismatchedPayloadController).toBeDefined()
    })

    it('provides typed request body in handler', () => {
      class TypedRequestController extends AbstractSSEController<ChatStreamContracts> {
        public static contracts = { chatStream: chatStreamContract } as const

        public buildSSERoutes(): BuildSSERoutesReturnType<ChatStreamContracts> {
          return {
            chatStream: {
              contract: TypedRequestController.contracts.chatStream,
              handler: this.handleChat,
            },
          }
        }

        private handleChat = buildSSEHandler(chatStreamContract, (request, _connection, _send) => {
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

        public buildSSERoutes(): BuildSSERoutesReturnType<ChatStreamContracts> {
          return {
            chatStream: {
              contract: TypedHeadersController.contracts.chatStream,
              handler: this.handleChat,
            },
          }
        }

        private handleChat = buildSSEHandler(chatStreamContract, (request, _connection, _send) => {
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
})
