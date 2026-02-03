// Re-export buildContract from contracts module
export { buildContract } from '../contracts/index.js'
// Re-export route types from routes module
export {
  type BuildFastifyDualModeRoutesReturnType,
  buildFastifyRoute,
  buildHandler,
  type DualModeHandlers,
  type DualModeRouteHandler,
  determineMode,
  extractPathTemplate,
  type FastifyDualModeHandlerConfig,
  type FastifyDualModeRouteOptions,
  type JsonModeHandler,
  type RegisterDualModeRoutesOptions,
  type SSEModeHandler,
  type SyncModeHandler,
} from '../routes/index.js'
export {
  AbstractDualModeController,
  type AllDualModeContractEventNames,
  type ExtractDualModeEventSchema,
} from './AbstractDualModeController.js'
export type {
  AnyDualModeContractDefinition,
  DualModeMethod,
  MultiFormatResponses,
  PathResolver,
  SimplifiedDualModeContractDefinition,
  VerboseDualModeContractDefinition,
} from './dualModeContracts.js'
export { isSimplifiedContract, isVerboseContract } from './dualModeContracts.js'
// Framework-agnostic types
export type {
  DualModeControllerConfig,
  DualModeLogger,
  DualModeType,
} from './dualModeTypes.js'
