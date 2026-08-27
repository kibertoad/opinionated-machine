import type { FastifyInstance } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { createSSETestServer, type SSETestServerWithResources } from '../../sseTestServerFactory.ts'

/**
 * A gate a handler awaits, so a test can hold it mid-stream and assert what the client has
 * already received while the handler is demonstrably still running.
 */
export type HandlerGate = {
  /** Resolves once the handler reached the gate. */
  reached: Promise<void>
  /** Let the handler continue past the gate. */
  release: () => void
  /** Whether the handler ran to completion. */
  isFinished: () => boolean
  /** Mark the handler as finished — called by the handler itself. */
  finish: () => void
  /** The promise the handler awaits. */
  wait: () => Promise<void>
}

export function createHandlerGate(): HandlerGate {
  let release: () => void = () => {}
  let markReached: () => void = () => {}
  let finished = false

  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const reached = new Promise<void>((resolve) => {
    markReached = resolve
  })

  return {
    reached,
    release,
    isFinished: () => finished,
    finish: () => {
      finished = true
    },
    wait: () => {
      markReached()
      return gate
    },
  }
}

/**
 * Start a Fastify app with `@fastify/sse` and the Zod compilers registered, carrying only the
 * routes a single test needs.
 *
 * The SSE specs that assert on delivery timing need handlers wired to per-test gates, which a
 * DI module fixture cannot express — so those routes are registered directly here.
 */
export function startSSEStreamTestApp(
  registerRoutes: (app: FastifyInstance) => void,
): Promise<SSETestServerWithResources<undefined>> {
  return createSSETestServer<undefined>(registerRoutes, {
    configureApp: (app) => {
      app.setValidatorCompiler(validatorCompiler)
      app.setSerializerCompiler(serializerCompiler)
    },
  })
}
