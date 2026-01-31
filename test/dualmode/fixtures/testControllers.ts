import {
  AbstractDualModeController,
  type BuildFastifyDualModeRoutesReturnType,
  buildHandler,
} from '../../../index.js'
import {
  authenticatedDualModeContract,
  chatCompletionContract,
  conversationCompletionContract,
  defaultMethodContract,
  defaultModeTestContract,
  errorTestContract,
  jobStatusContract,
  jsonValidationContract,
} from './testContracts.js'

/**
 * Basic chat dual-mode controller for testing Accept header routing.
 */
export type TestChatContracts = {
  chatCompletion: typeof chatCompletionContract
}

export class TestChatDualModeController extends AbstractDualModeController<TestChatContracts> {
  public static contracts = {
    chatCompletion: chatCompletionContract,
  } as const

  public buildDualModeRoutes(): BuildFastifyDualModeRoutesReturnType<TestChatContracts> {
    return {
      chatCompletion: {
        contract: TestChatDualModeController.contracts.chatCompletion,
        handlers: buildHandler(chatCompletionContract, {
          json: (ctx) => {
            const words = ctx.request.body.message.split(' ')
            return {
              reply: `Echo: ${ctx.request.body.message}`,
              usage: { tokens: words.length },
            }
          },
          sse: async (ctx) => {
            const words = ctx.request.body.message.split(' ')
            for (const word of words) {
              await ctx.connection.send('chunk', { delta: word })
            }
            await ctx.connection.send('done', { usage: { total: words.length } })
            this.closeConnection(ctx.connection.id)
          },
        }),
      },
    }
  }
}

/**
 * Conversation dual-mode controller with path params.
 */
export type TestConversationContracts = {
  conversationCompletion: typeof conversationCompletionContract
}

export class TestConversationDualModeController extends AbstractDualModeController<TestConversationContracts> {
  public static contracts = {
    conversationCompletion: conversationCompletionContract,
  } as const

  public buildDualModeRoutes(): BuildFastifyDualModeRoutesReturnType<TestConversationContracts> {
    return {
      conversationCompletion: {
        contract: TestConversationDualModeController.contracts.conversationCompletion,
        handlers: buildHandler(conversationCompletionContract, {
          json: (ctx) => ({
            reply: `Response for conversation ${ctx.request.params.conversationId}: ${ctx.request.body.message}`,
            conversationId: ctx.request.params.conversationId,
          }),
          sse: async (ctx) => {
            const words = ctx.request.body.message.split(' ')
            for (const word of words) {
              await ctx.connection.send('chunk', { delta: word })
            }
            await ctx.connection.send('done', {
              conversationId: ctx.request.params.conversationId,
            })
            this.closeConnection(ctx.connection.id)
          },
        }),
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
}

/**
 * Job status dual-mode controller with GET method.
 */
export type TestJobStatusContracts = {
  jobStatus: typeof jobStatusContract
}

export class TestJobStatusDualModeController extends AbstractDualModeController<TestJobStatusContracts> {
  public static contracts = {
    jobStatus: jobStatusContract,
  } as const

  // For testing: simulate different job states
  private jobStates: Map<string, { status: string; progress: number; result?: string }> = new Map()

  public setJobState(
    jobId: string,
    state: { status: string; progress: number; result?: string },
  ): void {
    this.jobStates.set(jobId, state)
  }

  public buildDualModeRoutes(): BuildFastifyDualModeRoutesReturnType<TestJobStatusContracts> {
    return {
      jobStatus: {
        contract: TestJobStatusDualModeController.contracts.jobStatus,
        handlers: buildHandler(jobStatusContract, {
          json: (ctx) => {
            const state = this.jobStates.get(ctx.request.params.jobId)
            if (!state) {
              return {
                status: 'pending' as const,
                progress: 0,
              }
            }
            return {
              status: state.status as 'pending' | 'running' | 'completed' | 'failed',
              progress: state.progress,
              result: state.result,
            }
          },
          sse: async (ctx) => {
            const state = this.jobStates.get(ctx.request.params.jobId)
            if (!state) {
              await ctx.connection.send('progress', { percent: 0 })
              this.closeConnection(ctx.connection.id)
              return
            }

            // Simulate progress updates
            for (let i = 0; i <= state.progress; i += 25) {
              await ctx.connection.send('progress', {
                percent: Math.min(i, state.progress),
                message: `Processing... ${i}%`,
              })
            }

            if (state.status === 'completed' && state.result) {
              await ctx.connection.send('done', { result: state.result })
            } else if (state.status === 'failed') {
              await ctx.connection.send('error', { code: 'JOB_FAILED', message: 'Job failed' })
            }

            this.closeConnection(ctx.connection.id)
          },
        }),
      },
    }
  }
}

/**
 * Authenticated dual-mode controller for testing preHandler.
 */
export type TestAuthenticatedContracts = {
  protectedAction: typeof authenticatedDualModeContract
}

export class TestAuthenticatedDualModeController extends AbstractDualModeController<TestAuthenticatedContracts> {
  public static contracts = {
    protectedAction: authenticatedDualModeContract,
  } as const

  public buildDualModeRoutes(): BuildFastifyDualModeRoutesReturnType<TestAuthenticatedContracts> {
    return {
      protectedAction: {
        contract: TestAuthenticatedDualModeController.contracts.protectedAction,
        handlers: buildHandler(authenticatedDualModeContract, {
          json: async (ctx) => ({
            success: true,
            data: `Processed: ${ctx.request.body.data}`,
          }),
          sse: async (ctx) => {
            await ctx.connection.send('result', {
              success: true,
              data: `Processed: ${ctx.request.body.data}`,
            })
            this.closeConnection(ctx.connection.id)
          },
        }),
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
}

/**
 * Controller for testing default mode behavior.
 */
export type TestDefaultModeContracts = {
  defaultModeTest: typeof defaultModeTestContract
}

export class TestDefaultModeDualModeController extends AbstractDualModeController<TestDefaultModeContracts> {
  public static contracts = {
    defaultModeTest: defaultModeTestContract,
  } as const

  public buildDualModeRoutes(): BuildFastifyDualModeRoutesReturnType<TestDefaultModeContracts> {
    return {
      defaultModeTest: {
        contract: TestDefaultModeDualModeController.contracts.defaultModeTest,
        handlers: buildHandler(defaultModeTestContract, {
          json: async (ctx) => ({
            output: `JSON: ${ctx.request.body.input}`,
          }),
          sse: async (ctx) => {
            await ctx.connection.send('output', { value: `SSE: ${ctx.request.body.input}` })
            this.closeConnection(ctx.connection.id)
          },
        }),
        options: {
          defaultMode: 'sse', // Set SSE as default mode
        },
      },
    }
  }
}

/**
 * Controller for testing error handling in SSE mode.
 */
export type TestErrorContracts = {
  errorTest: typeof errorTestContract
}

export class TestErrorDualModeController extends AbstractDualModeController<TestErrorContracts> {
  public static contracts = {
    errorTest: errorTestContract,
  } as const

  public buildDualModeRoutes(): BuildFastifyDualModeRoutesReturnType<TestErrorContracts> {
    return {
      errorTest: {
        contract: TestErrorDualModeController.contracts.errorTest,
        handlers: buildHandler(errorTestContract, {
          json: (ctx) => ({
            success: !ctx.request.body.shouldThrow,
          }),
          sse: async (ctx) => {
            if (ctx.request.body.shouldThrow) {
              throw new Error('Test error in SSE handler')
            }
            await ctx.connection.send('result', { success: true })
            this.closeConnection(ctx.connection.id)
          },
        }),
      },
    }
  }
}

/**
 * Controller for testing default method behavior (method omitted in contract).
 */
export type TestDefaultMethodContracts = {
  defaultMethodTest: typeof defaultMethodContract
}

export class TestDefaultMethodDualModeController extends AbstractDualModeController<TestDefaultMethodContracts> {
  public static contracts = {
    defaultMethodTest: defaultMethodContract,
  } as const

  public buildDualModeRoutes(): BuildFastifyDualModeRoutesReturnType<TestDefaultMethodContracts> {
    return {
      defaultMethodTest: {
        contract: TestDefaultMethodDualModeController.contracts.defaultMethodTest,
        handlers: buildHandler(defaultMethodContract, {
          json: (ctx) => ({
            result: `Processed: ${ctx.request.body.value}`,
          }),
          sse: async (ctx) => {
            await ctx.connection.send('data', { value: ctx.request.body.value })
            this.closeConnection(ctx.connection.id)
          },
        }),
      },
    }
  }
}

/**
 * Controller for testing JSON response validation failure.
 * When returnInvalid is true, returns data that doesn't match the syncResponse schema.
 */
export type TestJsonValidationContracts = {
  jsonValidationTest: typeof jsonValidationContract
}

export class TestJsonValidationDualModeController extends AbstractDualModeController<TestJsonValidationContracts> {
  public static contracts = {
    jsonValidationTest: jsonValidationContract,
  } as const

  public buildDualModeRoutes(): BuildFastifyDualModeRoutesReturnType<TestJsonValidationContracts> {
    return {
      jsonValidationTest: {
        contract: TestJsonValidationDualModeController.contracts.jsonValidationTest,
        handlers: buildHandler(jsonValidationContract, {
          json: (ctx): { requiredField: string; count: number } => {
            if (ctx.request.body.returnInvalid) {
              // @ts-expect-error Intentionally returning invalid data to test validation failure
              return { wrongField: 'invalid', count: -5 }
            }
            return { requiredField: 'valid', count: 42 }
          },
          sse: async (ctx) => {
            await ctx.connection.send('result', { success: true })
            this.closeConnection(ctx.connection.id)
          },
        }),
      },
    }
  }
}
