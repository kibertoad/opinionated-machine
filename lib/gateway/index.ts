export {
  type FastifyGatewayPluginOptions,
  fastifyGatewayPlugin,
  type GatewayDecorator,
} from './fastifyGatewayPlugin.ts'
export {
  type Duration,
  durationSchema,
  type GatewayMetadataValue,
  gatewayMetadataSchema,
  type MatchRule,
  matchRuleSchema,
} from './gatewayMetadata.ts'
export { GATEWAY_METADATA_SYMBOL } from './gatewaySymbol.ts'
export type {
  ContractHeaderKey,
  ContractQueryKey,
  GatewayMetadata,
} from './gatewayTypes.ts'
export {
  type BuildGatewayManifestOptions,
  buildGatewayManifestFrom,
  type CollectedController,
} from './manifest/buildManifest.ts'
export {
  type GatewayManifest,
  type GatewayManifestRoute,
  gatewayManifestRouteSchema,
  gatewayManifestSchema,
} from './manifest/manifestSchema.ts'
export { normalizePath } from './manifest/pathNormalize.ts'
export { readGatewayMetadata, withGatewayMetadata } from './withGatewayMetadata.ts'
