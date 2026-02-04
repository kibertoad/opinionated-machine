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
  statusCodeValidationContract,
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
      chatCompletion: this.handleChatCompletion,
    }
  }

  private handleChatCompletion = buildHandler(chatCompletionContract, {
    sync: (request) => {
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
        await connection.send('chunk', { content: word })
      }
      await connection.send('done', { usage: { totalTokens: words.length } })
      // autoClose mode
    },
  })
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
      conversationCompletion: this.handleConversationCompletion,
    }
  }

  private handleConversationCompletion = buildHandler(
    conversationCompletionContract,
    {
      sync: (request) => ({
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
    },
    {
      preHandler: (request, reply) => {
        const auth = request.headers.authorization
        if (!auth || !auth.startsWith('Bearer ')) {
          return Promise.resolve(reply.code(401).send({ error: 'Unauthorized' }))
        }
        return Promise.resolve()
      },
    },
  )
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
      jobStatus: this.handleJobStatus,
    }
  }

  private handleJobStatus = buildHandler(jobStatusContract, {
    sync: (request) => {
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
  })
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
      protectedAction: this.handleProtectedAction,
    }
  }

  private handleProtectedAction = buildHandler(
    authenticatedDualModeContract,
    {
      sync: (request) => ({
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
    },
    {
      preHandler: (request, reply) => {
        const auth = request.headers.authorization
        if (!auth || !auth.startsWith('Bearer ')) {
          return Promise.resolve(reply.code(401).send({ error: 'Unauthorized' }))
        }
        return Promise.resolve()
      },
    },
  )
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
      defaultModeTest: this.handleDefaultModeTest,
    }
  }

  private handleDefaultModeTest = buildHandler(
    defaultModeTestContract,
    {
      sync: (request) => ({
        output: `JSON: ${request.body.input}`,
      }),
      sse: async (request, sse) => {
        const connection = sse.start('autoClose')
        await connection.send('output', { value: `SSE: ${request.body.input}` })
        // autoClose mode
      },
    },
    {
      defaultMode: 'sse', // Set SSE as default mode
    },
  )
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
      errorTest: this.handleErrorTest,
    }
  }

  private handleErrorTest = buildHandler(errorTestContract, {
    sync: (request) => ({
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
  })
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
      defaultMethodTest: this.handleDefaultMethodTest,
    }
  }

  private handleDefaultMethodTest = buildHandler(defaultMethodContract, {
    sync: (request) => ({
      result: `Processed: ${request.body.value}`,
    }),
    sse: async (request, sse) => {
      const connection = sse.start('autoClose')
      await connection.send('data', { value: request.body.value })
      // autoClose mode
    },
  })
}

/**
 * Controller for testing sync response validation failure.
 * When returnInvalid is true, returns data that doesn't match the syncResponseBody schema.
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
      jsonValidationTest: this.handleJsonValidationTest,
    }
  }

  private handleJsonValidationTest = buildHandler(jsonValidationContract, {
    sync: (request): { requiredField: string; count: number } => {
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
  })
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
 * Controller for testing responseSchemasByStatusCode validation.
 * When returnStatus is set to 400 or 404, returns appropriate error responses.
 * When returnValid is false, returns data that doesn't match the schema.
 */
export type TestStatusCodeValidationContracts = {
  statusCodeValidation: typeof statusCodeValidationContract
}

export class TestStatusCodeValidationDualModeController extends AbstractDualModeController<TestStatusCodeValidationContracts> {
  public static contracts = {
    statusCodeValidation: statusCodeValidationContract,
  } as const

  public buildDualModeRoutes(): BuildFastifyDualModeRoutesReturnType<TestStatusCodeValidationContracts> {
    return {
      statusCodeValidation: this.handleStatusCodeValidation,
    }
  }

  // Note: For error responses (non-2xx), TypeScript handler return types don't account for
  // responseSchemasByStatusCode which allows different response shapes per status code.
  // We use 'as any' only for error responses since the type system only knows about syncResponseBody.
  private handleStatusCodeValidation = buildHandler(statusCodeValidationContract, {
    sync: (request, reply) => {
      const { returnStatus, returnValid } = request.body

      if (returnStatus === 400) {
        reply.code(400)
        if (returnValid) {
          // Valid 400 response per responseSchemasByStatusCode
          // TypeScript doesn't know about error response schemas, so we cast
          return { error: 'Bad Request', details: ['Invalid input', 'Missing field'] } as any
        }
        // Invalid 400 response - missing 'details' field (for testing validation failure)
        return { error: 'Bad Request', wrongField: 'invalid' } as any
      }

      if (returnStatus === 404) {
        reply.code(404)
        if (returnValid) {
          // Valid 404 response per responseSchemasByStatusCode
          return { error: 'Not Found', resourceId: 'item-123' } as any
        }
        // Invalid 404 response - missing 'resourceId' field (for testing validation failure)
        return { error: 'Not Found', wrongField: 'invalid' } as any
      }

      // Success case - 200 (matches syncResponseBody) - no cast needed
      return { success: true, data: 'OK' }
    },
    sse: async (_request, sse) => {
      const connection = sse.start('autoClose')
      await connection.send('result', { success: true })
    },
  })
}

// NOTE: Multi-format controllers removed - multi-format support is deprecated
