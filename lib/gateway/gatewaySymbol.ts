/**
 * Symbol used to attach gateway metadata to a Fastify route object.
 *
 * Stamped as a non-enumerable property by `withGatewayMetadata()` and read by
 * `DIContext.buildGatewayManifest()`. Using `Symbol.for` ensures every module
 * resolving the same key gets the same symbol, even across realms or duplicate
 * package copies.
 */
export const GATEWAY_METADATA_SYMBOL = Symbol.for('opinionated-machine.gateway.metadata')
