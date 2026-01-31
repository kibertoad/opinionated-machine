import type { z } from 'zod'
import { AbstractSSEController } from '../sse/AbstractSSEController.ts'
import type { AnySSERouteDefinition } from '../sse/sseContracts.ts'
import type { BuildSSERoutesReturnType, SSEControllerConfig } from '../sse/sseTypes.ts'
import type { AnyDualModeRouteDefinition } from './dualModeContracts.ts'
import type { BuildDualModeRoutesReturnType, DualModeControllerConfig } from './dualModeTypes.ts'

/**
 * Extract all event names from dual-mode contracts as a union of string literals.
 */
export type AllDualModeContractEventNames<
  Contracts extends Record<string, AnyDualModeRouteDefinition>,
> = Contracts[keyof Contracts]['events'] extends infer E
  ? E extends Record<string, z.ZodTypeAny>
    ? keyof E & string
    : never
  : never

/**
 * Extract the schema for a specific event name across all dual-mode contracts.
 */
export type ExtractDualModeEventSchema<
  Contracts extends Record<string, AnyDualModeRouteDefinition>,
  EventName extends string,
> = {
  [K in keyof Contracts]: EventName extends keyof Contracts[K]['events']
    ? Contracts[K]['events'][EventName]
    : never
}[keyof Contracts]

/**
 * Abstract base class for dual-mode controllers.
 *
 * Dual-mode controllers handle both SSE streaming and JSON responses on the
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
 *     chatCompletion: buildPayloadDualModeRoute({ ... }),
 *   } as const
 *
 *   constructor(deps: Dependencies, config?: DualModeControllerConfig) {
 *     super(deps, config)
 *   }
 *
 *   public buildDualModeRoutes() {
 *     return {
 *       chatCompletion: {
 *         contract: ChatController.contracts.chatCompletion,
 *         handlers: buildDualModeHandler(ChatController.contracts.chatCompletion, {
 *           json: async (ctx) => {
 *             // Return complete JSON response
 *             return { reply: 'Hello', usage: { tokens: 5 } }
 *           },
 *           sse: async (ctx) => {
 *             // Stream SSE events
 *             await ctx.connection.send('chunk', { delta: 'Hello' })
 *             await ctx.connection.send('done', { usage: { total: 5 } })
 *             this.closeConnection(ctx.connection.id)
 *           },
 *         }),
 *       },
 *     }
 *   }
 * }
 * ```
 */
export abstract class AbstractDualModeController<
  APIContracts extends Record<string, AnyDualModeRouteDefinition>,
> extends AbstractSSEController<Record<string, AnySSERouteDefinition>> {
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
  public abstract buildDualModeRoutes(): BuildDualModeRoutesReturnType<APIContracts>

  /**
   * SSE routes are not used directly - dual-mode uses buildDualModeRoutes() instead.
   * This returns an empty object to satisfy the AbstractSSEController contract.
   */
  public buildSSERoutes(): BuildSSERoutesReturnType<Record<string, AnySSERouteDefinition>> {
    return {} as BuildSSERoutesReturnType<Record<string, AnySSERouteDefinition>>
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
