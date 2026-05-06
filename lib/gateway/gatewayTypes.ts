import type { z } from 'zod/v4'
import type { GatewayMetadataValue, MatchRule } from './gatewayMetadata.ts'

/**
 * Lowercase-keyed header names inferred from `contract.requestHeaderSchema`.
 * Falls back to `never` when no header schema is declared, forcing developers
 * to use the explicit `customHeaders` escape hatch.
 *
 * HTTP headers are case-insensitive; we lowercase here because gateway configs
 * (Envoy, KrakenD) match against lowercase header names.
 */
export type ContractHeaderKey<C> = C extends {
  requestHeaderSchema: z.ZodObject<infer Shape>
}
  ? Lowercase<Extract<keyof Shape, string>>
  : never

/**
 * Query parameter names inferred from `contract.requestQuerySchema`.
 * Falls back to `never` when no query schema is declared.
 */
export type ContractQueryKey<C> = C extends {
  requestQuerySchema: z.ZodObject<infer Shape>
}
  ? Extract<keyof Shape, string>
  : never

type ContractMatch<Contract> = {
  /** Keys narrowed to `requestHeaderSchema`. Use `customHeaders` for headers not in the contract. */
  headers?: Partial<Record<ContractHeaderKey<Contract>, MatchRule>>
  /** Escape hatch for headers not declared on the contract (CDN, infra, auth tokens). */
  customHeaders?: Record<string, MatchRule>
  /** Keys narrowed to `requestQuerySchema`. Use `customQuery` for params not in the contract. */
  query?: Partial<Record<ContractQueryKey<Contract>, MatchRule>>
  /** Escape hatch for query params not declared on the contract. */
  customQuery?: Record<string, MatchRule>
  host?: string | string[]
}

type ContractRateLimitKey<Contract> =
  | 'ip'
  | { header: ContractHeaderKey<Contract> }
  | { customHeader: string }
  | { query: ContractQueryKey<Contract> }
  | { customQuery: string }

/**
 * Per-route gateway metadata, generic in the route's contract.
 *
 * `match.headers` and `match.query` keys are narrowed to the contract's request
 * schemas, catching typos and stale references at compile time. For headers /
 * query params not in the contract, use the explicit `customHeaders` /
 * `customQuery` escape hatches.
 *
 * Defaults at the controller / service level are unbound by a contract — use
 * `GatewayMetadata` (no generic) which expands to the same shape with `string`
 * keys for matching.
 */
export type GatewayMetadata<Contract = unknown> = Omit<
  GatewayMetadataValue,
  'match' | 'rateLimit'
> & {
  match?: ContractMatch<Contract>
  rateLimit?: Omit<NonNullable<GatewayMetadataValue['rateLimit']>, 'key'> & {
    key?: ContractRateLimitKey<Contract>
  }
}
