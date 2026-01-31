// Re-export buildContract from contracts module
export { buildContract } from '../contracts/index.js'
export {
  AbstractDualModeController,
  type AllDualModeContractEventNames,
  type ExtractDualModeEventSchema,
} from './AbstractDualModeController.js'
export type {
  AnyDualModeContractDefinition,
  DualModeContractConfig,
  DualModeContractDefinition,
  DualModeMethod,
  PathResolver,
  PayloadDualModeContractConfig,
} from './dualModeContracts.js'
// Framework-agnostic types
export type {
  DualModeControllerConfig,
  DualModeLogger,
  DualModeType,
} from './dualModeTypes.js'
// Fastify-specific
export {
  buildFastifyDualModeRoute,
  determineMode,
  extractPathTemplate,
} from './fastifyDualModeRouteBuilder.js'
export {
  type BuildFastifyDualModeRoutesReturnType,
  buildDualModeHandler,
  type DualModeHandlers,
  type FastifyDualModeHandlerConfig,
  type FastifyDualModeRouteOptions,
  type JsonModeContext,
  type JsonModeHandler,
  type RegisterDualModeRoutesOptions,
  type SSEModeContext,
  type SSEModeHandler,
} from './fastifyDualModeTypes.js'
