import { z } from 'zod/v4'

/**
 * Duration string in the format "<number><unit>", e.g. "5s", "300ms", "1m", "2h".
 * Parsed at generation time by individual gateway generators.
 */
export const durationSchema = z.string().regex(/^\d+(ms|s|m|h)$/, {
  message: 'Duration must be a number followed by ms, s, m, or h (e.g. "5s", "300ms").',
})
export type Duration = z.infer<typeof durationSchema>

/**
 * Match rule for a single header or query value.
 * Bare strings are treated as exact matches; objects are explicit.
 */
export const matchRuleSchema = z.union([
  z.string(),
  z.object({ exact: z.string() }),
  z.object({ prefix: z.string() }),
  z.object({ regex: z.string() }),
])
export type MatchRule = z.infer<typeof matchRuleSchema>

const httpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

const matchSchema = z
  .object({
    headers: z.record(z.string(), matchRuleSchema).optional(),
    customHeaders: z.record(z.string(), matchRuleSchema).optional(),
    query: z.record(z.string(), matchRuleSchema).optional(),
    customQuery: z.record(z.string(), matchRuleSchema).optional(),
    host: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .strict()

const rewriteSchema = z
  .object({
    stripPrefix: z.string().optional(),
    replacePrefix: z.object({ from: z.string(), to: z.string() }).strict().optional(),
  })
  .strict()

const timeoutsSchema = z
  .object({
    request: durationSchema.optional(),
    idle: durationSchema.optional(),
    connect: durationSchema.optional(),
  })
  .strict()

const retrySchema = z
  .object({
    attempts: z.number().int().min(0).optional(),
    on: z
      .array(z.enum(['5xx', 'gateway-error', 'connect-failure', 'reset', 'retriable-4xx']))
      .optional(),
    perTryTimeout: durationSchema.optional(),
    backoff: z
      .object({ base: durationSchema.optional(), max: durationSchema.optional() })
      .strict()
      .optional(),
  })
  .strict()

const circuitBreakerSchema = z
  .object({
    maxConnections: z.number().int().positive().optional(),
    maxPendingRequests: z.number().int().positive().optional(),
    maxRequests: z.number().int().positive().optional(),
    maxRetries: z.number().int().nonnegative().optional(),
  })
  .strict()

const rateLimitKeySchema = z.union([
  z.literal('ip'),
  z.object({ header: z.string() }).strict(),
  z.object({ customHeader: z.string() }).strict(),
  z.object({ query: z.string() }).strict(),
  z.object({ customQuery: z.string() }).strict(),
])

const rateLimitSchema = z
  .object({
    requests: z.number().int().positive(),
    per: durationSchema,
    key: rateLimitKeySchema.optional(),
  })
  .strict()

const trafficSchema = z
  .object({
    weights: z
      .array(z.object({ upstream: z.string(), weight: z.number().int().min(0).max(100) }).strict())
      .optional(),
    shadow: z
      .object({
        upstream: z.string(),
        percent: z.number().min(0).max(100),
      })
      .strict()
      .optional(),
  })
  .strict()

const corsSchema = z
  .object({
    origins: z.array(z.string()),
    methods: z.array(httpMethodSchema).optional(),
    headers: z.array(z.string()).optional(),
    exposeHeaders: z.array(z.string()).optional(),
    credentials: z.boolean().optional(),
    maxAge: durationSchema.optional(),
  })
  .strict()

const authSchema = z
  .object({
    required: z.boolean().optional(),
    jwt: z
      .object({
        issuer: z.string(),
        audiences: z.array(z.string()).optional(),
        jwksUri: z.string().optional(),
      })
      .strict()
      .optional(),
    mTLS: z.boolean().optional(),
  })
  .strict()

const cacheSchema = z
  .object({
    ttl: durationSchema,
    methods: z.array(z.enum(['GET', 'HEAD'])).optional(),
    vary: z.array(z.string()).optional(),
  })
  .strict()

const headersSchema = z
  .object({
    request: z
      .object({
        add: z.record(z.string(), z.string()).optional(),
        remove: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    response: z
      .object({
        add: z.record(z.string(), z.string()).optional(),
        remove: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

const extensionsSchema = z.record(z.string(), z.record(z.string(), z.unknown()).optional())

/**
 * Universal gateway metadata schema.
 *
 * Vendor-neutral. Generators map every field they support and put unmapped
 * data into `warnings`. Use `extensions.<vendor>` for gateway-specific knobs
 * the universal model doesn't cover.
 */
export const gatewayMetadataSchema = z
  .object({
    id: z.string().optional(),
    upstream: z.string().optional(),
    visibility: z.enum(['public', 'internal', 'admin']).optional(),
    tags: z.array(z.string()).optional(),

    match: matchSchema.optional(),
    rewrite: rewriteSchema.optional(),

    timeouts: timeoutsSchema.optional(),
    retry: retrySchema.optional(),
    circuitBreaker: circuitBreakerSchema.optional(),

    rateLimit: rateLimitSchema.optional(),
    traffic: trafficSchema.optional(),

    cors: corsSchema.optional(),
    auth: authSchema.optional(),
    cache: cacheSchema.optional(),

    headers: headersSchema.optional(),

    extensions: extensionsSchema.optional(),
  })
  .strict()

/**
 * Runtime-validated gateway metadata.
 *
 * For per-route declarations use the contract-generic alias `GatewayMetadata<Contract>`
 * exported from `./gatewayTypes.ts` — the runtime schema is intentionally lenient
 * about header/query keys (case-insensitive HTTP, dynamic keys); the type-level
 * narrowing is what guides authoring.
 */
export type GatewayMetadataValue = z.infer<typeof gatewayMetadataSchema>
