import type {
  AnyDualModeContractDefinition,
  AnySSEContractDefinition,
} from '@lokalise/api-contracts'
import type { z } from 'zod'
import type {
  BuildFastifyDualModeRoutesReturnType,
  BuildFastifySSERoutesReturnType,
} from '../routes/fastifyRouteTypes.ts'
import { AbstractSSEController } from '../sse/AbstractSSEController.ts'
import type { SSEControllerConfig } from '../sse/sseTypes.ts'
import type { DualModeControllerConfig } from './dualModeTypes.ts'

/**
 * Extract all event names from dual-mode contracts as a union of string literals.
 */
export type AllDualModeContractEventNames<
  Contracts extends Record<string, AnyDualModeContractDefinition>,
> = Contracts[keyof Contracts]['serverSentEventSchemas'] extends infer E
  ? E extends Record<string, z.ZodTypeAny>
    ? keyof E & string
    : never
  : never

/**
 * Extract the schema for a specific event name across all dual-mode contracts.
 */
export type ExtractDualModeEventSchema<
  Contracts extends Record<string, AnyDualModeContractDefinition>,
  EventName extends string,
> = {
  [K in keyof Contracts]: EventName extends keyof Contracts[K]['serverSentEventSchemas']
    ? Contracts[K]['serverSentEventSchemas'][EventName]
    : never
}[keyof Contracts]

/**
 * Abstract base class for dual-mode controllers.
 *
 * Dual-mode controllers handle both SSE streaming and sync responses on the
 * same route path, automatically branching based on the `Accept` header.
 *
 * This class extends `AbstractSSEController` to reuse connection management,
 * broadcasting, and lifecycle hooks for the SSE mode.
 *
 * @template APIContracts - Map of route names to dual-mode route definitions
 *
 * @example
 * ```typescript
 * class ChatController extends AbstractDualModeController<typeof contracts> {
 *   public static contracts = {
 *     chatCompletion: buildSseContract({ requestBodySchema: ..., successResponseBodySchema: ..., ... }),
 *   } as const
 *
 *   constructor(deps: Dependencies, config?: DualModeControllerConfig) {
 *     super(deps, config)
 *   }
 *
 *   public buildDualModeRoutes() {
 *     return {
 *       chatCompletion: this.handleChatCompletion,
 *     }
 *   }
 *
 *   private handleChatCompletion = buildHandler(ChatController.contracts.chatCompletion, {
 *     sync: async (request, reply) => {
 *       // Return complete response
 *       return { reply: 'Hello', usage: { tokens: 5 } }
 *     },
 *     sse: async (request, sse) => {
 *       // Stream SSE events with autoClose mode
 *       const session = sse.start('autoClose')
 *       await session.send('chunk', { delta: 'Hello' })
 *       await session.send('done', { usage: { total: 5 } })
 *       // Connection closes automatically when handler returns
 *     },
 *   })
 * }
 * ```
 */
export abstract class AbstractDualModeController<
  APIContracts extends Record<string, AnyDualModeContractDefinition>,
> extends AbstractSSEController<Record<string, AnySSEContractDefinition>> {
  /**
   * Dual-mode controllers must override this constructor and call super with their
   * dependencies object and the dual-mode config.
   *
   * @param _dependencies - The dependencies object (cradle proxy in awilix)
   * @param config - Optional dual-mode controller configuration
   */
  constructor(_dependencies: object, config?: DualModeControllerConfig) {
    // Pass config to AbstractSSEController (it accepts SSEControllerConfig which has the same shape)
    super(_dependencies, config as SSEControllerConfig)
  }

  /**
   * Build and return dual-mode route configurations.
   * Must be implemented by concrete controllers.
   */
  public abstract buildDualModeRoutes(): BuildFastifyDualModeRoutesReturnType<APIContracts>

  /**
   * SSE routes are not used directly - dual-mode uses buildDualModeRoutes() instead.
   * This returns an empty object to satisfy the AbstractSSEController contract.
   */
  public buildSSERoutes(): BuildFastifySSERoutesReturnType<
    Record<string, AnySSEContractDefinition>
  > {
    return {} as BuildFastifySSERoutesReturnType<Record<string, AnySSEContractDefinition>>
  }

  /**
   * Send an event to a connection with type-safe event names and data.
   *
   * This method provides autocomplete and type checking for event names and data
   * that match any event defined in the controller's dual-mode contracts.
   *
   * @param connectionId - The connection to send to
   * @param message - The event message with typed event name and data
   * @returns true if sent successfully, false if connection not found
   */
  public sendDualModeEventInternal<EventName extends AllDualModeContractEventNames<APIContracts>>(
    connectionId: string,
    message: {
      event: EventName
      data: z.input<ExtractDualModeEventSchema<APIContracts, EventName>>
      id?: string
      retry?: number
    },
  ): Promise<boolean> {
    return this._sendEventRaw(connectionId, message)
  }
}
