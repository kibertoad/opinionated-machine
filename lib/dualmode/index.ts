// Re-export buildContract from contracts module
export { buildContract } from '../contracts/index.js'
// Re-export route types from routes module
export {
  type BuildFastifyDualModeRoutesReturnType,
  buildFastifyRoute,
  buildHandler,
  type DualModeHandlers,
  determineMode,
  extractPathTemplate,
  type FastifyDualModeHandlerConfig,
  type FastifyDualModeRouteOptions,
  type JsonModeHandler,
  type RegisterDualModeRoutesOptions,
  type SSEModeHandler,
} from '../routes/index.js'
export {
  AbstractDualModeController,
  type AllDualModeContractEventNames,
  type ExtractDualModeEventSchema,
} from './AbstractDualModeController.js'
export type {
  AnyDualModeContractDefinition,
  DualModeContractDefinition,
  DualModeMethod,
  PathResolver,
} from './dualModeContracts.js'
// Framework-agnostic types
export type {
  DualModeControllerConfig,
  DualModeLogger,
  DualModeType,
} from './dualModeTypes.js'
