import type { FastifyInstance } from 'fastify'

// biome-ignore lint/suspicious/noExplicitAny: Fastify instance types are complex
export type AnyFastifyInstance = FastifyInstance<any, any, any, any>
