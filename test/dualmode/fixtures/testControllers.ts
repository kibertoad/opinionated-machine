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
  multiFormatExportContract,
  multiFormatReportContract,
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
          json: (request) => {
            const words = request.body.message.split(' ')
            return {
              reply: `Echo: ${request.body.message}`,
              usage: { tokens: words.length },
            }
          },
          sse: async (request, sse) => {
            const connection = sse.start('autoClose')
            const words = request.body.message.split(' ')
            for (const word of words) {
              await connection.send('chunk', { delta: word })
            }
            await connection.send('done', { usage: { total: words.length } })
            // autoClose mode
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
          json: (request) => ({
            reply: `Response for conversation ${request.params.conversationId}: ${request.body.message}`,
            conversationId: request.params.conversationId,
          }),
          sse: async (request, sse) => {
            const connection = sse.start('autoClose')
            const words = request.body.message.split(' ')
            for (const word of words) {
              await connection.send('chunk', { delta: word })
            }
            await connection.send('done', {
              conversationId: request.params.conversationId,
            })
            // autoClose mode
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
          json: (request) => {
            const state = this.jobStates.get(request.params.jobId)
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
          sse: async (request, sse) => {
            const connection = sse.start('autoClose')
            const state = this.jobStates.get(request.params.jobId)
            if (!state) {
              await connection.send('progress', { percent: 0 })
              return // autoClose mode - early return for no state
            }

            // Simulate progress updates
            for (let i = 0; i <= state.progress; i += 25) {
              await connection.send('progress', {
                percent: Math.min(i, state.progress),
                message: `Processing... ${i}%`,
              })
            }

            if (state.status === 'completed' && state.result) {
              await connection.send('done', { result: state.result })
            } else if (state.status === 'failed') {
              await connection.send('error', { code: 'JOB_FAILED', message: 'Job failed' })
            }
            // autoClose mode
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
          json: (request) => ({
            success: true,
            data: `Processed: ${request.body.data}`,
          }),
          sse: async (request, sse) => {
            const connection = sse.start('autoClose')
            await connection.send('result', {
              success: true,
              data: `Processed: ${request.body.data}`,
            })
            // autoClose mode
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
          json: (request) => ({
            output: `JSON: ${request.body.input}`,
          }),
          sse: async (request, sse) => {
            const connection = sse.start('autoClose')
            await connection.send('output', { value: `SSE: ${request.body.input}` })
            // autoClose mode
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
          json: (request) => ({
            success: !request.body.shouldThrow,
          }),
          sse: async (request, sse) => {
            const connection = sse.start('autoClose')
            if (request.body.shouldThrow) {
              throw new Error('Test error in SSE handler')
            }
            await connection.send('result', { success: true })
            // autoClose mode
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
          json: (request) => ({
            result: `Processed: ${request.body.value}`,
          }),
          sse: async (request, sse) => {
            const connection = sse.start('autoClose')
            await connection.send('data', { value: request.body.value })
            // autoClose mode
          },
        }),
      },
    }
  }
}

/**
 * Controller for testing JSON response validation failure.
 * When returnInvalid is true, returns data that doesn't match the jsonResponse schema.
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
          json: (request): { requiredField: string; count: number } => {
            if (request.body.returnInvalid) {
              // @ts-expect-error Intentionally returning invalid data to test validation failure
              return { wrongField: 'invalid', count: -5 }
            }
            return { requiredField: 'valid', count: 42 }
          },
          sse: async (_request, sse) => {
            const connection = sse.start('autoClose')
            await connection.send('result', { success: true })
            // autoClose mode
          },
        }),
      },
    }
  }
}

/**
 * Generic controller for ad-hoc contract testing.
 * Use this when you need to test inline contracts not registered in a specific controller.
 */
export type GenericDualModeContracts = Record<
  string,
  import('../../../index.js').AnyDualModeContractDefinition
>

export class GenericDualModeController extends AbstractDualModeController<GenericDualModeContracts> {
  public buildDualModeRoutes(): BuildFastifyDualModeRoutesReturnType<GenericDualModeContracts> {
    // This controller doesn't define its own routes - it's used for ad-hoc route building
    return {}
  }
}

/**
 * Multi-format export controller (verbose format with multiFormatResponses).
 */
export type TestMultiFormatExportContracts = {
  export: typeof multiFormatExportContract
}

export class TestMultiFormatExportController extends AbstractDualModeController<TestMultiFormatExportContracts> {
  public static contracts = {
    export: multiFormatExportContract,
  } as const

  public buildDualModeRoutes(): BuildFastifyDualModeRoutesReturnType<TestMultiFormatExportContracts> {
    return {
      export: {
        contract: TestMultiFormatExportController.contracts.export,
        handlers: buildHandler(multiFormatExportContract, {
          sync: {
            'application/json': (request) => ({
              items: request.body.data,
              count: request.body.data.length,
            }),
            'text/plain': (request) =>
              request.body.data.map((item) => `${item.name}: ${item.value}`).join('\n'),
            'text/csv': (request) =>
              `name,value\n${request.body.data.map((item) => `${item.name},${item.value}`).join('\n')}`,
          },
          sse: async (request, sse) => {
            const connection = sse.start('autoClose')
            const items = request.body.data
            for (let i = 0; i < items.length; i++) {
              await connection.send('progress', { percent: ((i + 1) / items.length) * 100 })
            }
            await connection.send('done', { totalItems: items.length })
            // autoClose mode
          },
        }),
      },
    }
  }
}

/**
 * Multi-format report controller (GET method with verbose format).
 */
export type TestMultiFormatReportContracts = {
  report: typeof multiFormatReportContract
}

export class TestMultiFormatReportController extends AbstractDualModeController<TestMultiFormatReportContracts> {
  public static contracts = {
    report: multiFormatReportContract,
  } as const

  public buildDualModeRoutes(): BuildFastifyDualModeRoutesReturnType<TestMultiFormatReportContracts> {
    return {
      report: {
        contract: TestMultiFormatReportController.contracts.report,
        handlers: buildHandler(multiFormatReportContract, {
          sync: {
            'application/json': (request) => ({
              id: request.params.reportId,
              title: `Report ${request.params.reportId}`,
              data: { detailed: request.query.detailed === 'true' },
            }),
            'text/plain': (request) =>
              `Report: ${request.params.reportId}\nDetailed: ${request.query.detailed ?? 'false'}`,
          },
          sse: async (request, sse) => {
            const connection = sse.start('autoClose')
            await connection.send('chunk', {
              content: `Streaming report ${request.params.reportId}`,
            })
            await connection.send('done', { totalSize: 100 })
            // autoClose mode
          },
        }),
      },
    }
  }
}
