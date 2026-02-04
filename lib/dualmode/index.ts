// Re-export contract types from @lokalise/api-contracts
export type {
  AnyDualModeContractDefinition,
  SimplifiedDualModeContractDefinition,
} from '@lokalise/api-contracts'
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
  type RegisterDualModeRoutesOptions,
  type SSEModeHandler,
  type SyncModeHandler,
} from '../routes/index.js'
export {
  AbstractDualModeController,
  type AllDualModeContractEventNames,
  type ExtractDualModeEventSchema,
} from './AbstractDualModeController.js'
// Framework-agnostic types
export type {
  DualModeControllerConfig,
  DualModeLogger,
  DualModeType,
} from './dualModeTypes.js'
