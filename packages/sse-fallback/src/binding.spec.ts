import { defineApiContract, sseBody } from '@lokalise/api-contracts'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod/v4'
import {
  bindFallbackContracts,
  defineFallbackBinding,
  fromLegacyDualModeContract,
  readFallbackBinding,
} from './binding.ts'
import type { FallbackEvent } from './bindingTypes.ts'

// ============================================================================
// Fixtures — real @lokalise/api-contracts contracts (devDependency)
// ============================================================================

const uploadStatusContract = defineApiContract({
  method: 'get',
  summary: 'Upload status',
  pathResolver: ({ uploadId }) => `/uploads/${uploadId}/status`,
  requestPathParamsSchema: z.object({ uploadId: z.string() }),
  responsesByStatusCode: {
    200: {
      content: {
        'application/json': z.object({
          status: z.enum(['pending', 'completed', 'failed']),
          result: z.string().optional(),
          version: z.number(),
        }),
        'text/event-stream': sseBody({
          progress: z.object({ percent: z.number() }),
          uploadFinished: z.object({ result: z.string() }),
          uploadFailed: z.object({ error: z.string() }),
        }),
      },
    },
  },
})

const plainPollContract = defineApiContract({
  method: 'get',
  summary: 'Poll only',
  pathResolver: () => '/jobs/current',
  responsesByStatusCode: {
    200: z.object({ status: z.string(), version: z.number() }),
  },
})

const sseOnlyContract = defineApiContract({
  method: 'get',
  summary: 'Stream only',
  pathResolver: () => '/jobs/stream',
  responsesByStatusCode: {
    200: {
      content: {
        'text/event-stream': sseBody({
          update: z.object({ status: z.string(), version: z.number() }),
        }),
      },
    },
  },
})

// ============================================================================
// defineFallbackBinding (primary form)
// ============================================================================

describe('defineFallbackBinding', () => {
  it('accepts a dual-mode contract and builds both requests from one path', () => {
    const binding = defineFallbackBinding(uploadStatusContract, {
      snapshotToEvents: (s) =>
        s.status === 'completed'
          ? [{ event: 'uploadFinished', data: { result: s.result as string } }]
          : [],
      version: { ofSnapshot: (s) => s.version },
      terminalEvents: ['uploadFinished', 'uploadFailed'],
    })

    const params = { pathParams: { uploadId: 'u1' } }
    expect(binding.buildSnapshotRequest(params)).toEqual({
      path: '/uploads/u1/status',
      method: 'get',
    })
    expect(binding.buildStreamRequest(params)).toEqual({
      path: '/uploads/u1/status',
      method: 'get',
    })
  })

  it('infers snapshot and event payload types from the contract', () => {
    defineFallbackBinding(uploadStatusContract, {
      snapshotToEvents: (s) => {
        expectTypeOf(s.status).toEqualTypeOf<'pending' | 'completed' | 'failed'>()
        expectTypeOf(s.version).toEqualTypeOf<number>()
        return []
      },
      version: {
        ofSnapshot: (s) => s.version,
        ofEvent: (e) => {
          expectTypeOf(e).toExtend<{ event: string; origin: 'sse' | 'poll' }>()
          return undefined
        },
      },
    })
  })

  it('rejects event names / payloads not declared on the contract at compile time', () => {
    defineFallbackBinding(uploadStatusContract, {
      // @ts-expect-error 'nope' is not a declared event
      snapshotToEvents: () => [{ event: 'nope', data: {} }],
      version: { ofSnapshot: (s) => s.version },
    })
    defineFallbackBinding(uploadStatusContract, {
      // @ts-expect-error payload shape mismatch for uploadFinished
      snapshotToEvents: () => [{ event: 'uploadFinished', data: { wrong: true } }],
      version: { ofSnapshot: (s) => s.version },
    })
  })

  it('throws for a non-dual contract', () => {
    expect(() =>
      defineFallbackBinding(plainPollContract, {
        snapshotToEvents: () => [],
        version: 'none',
      }),
    ).toThrow(/dual-mode contract/)
  })

  it('expands the snapshotEvent shorthand', () => {
    const contract = defineApiContract({
      method: 'get',
      summary: 'State',
      pathResolver: () => '/state',
      responsesByStatusCode: {
        200: {
          content: {
            'application/json': z.object({ revision: z.number() }),
            'text/event-stream': sseBody({ stateChanged: z.object({ revision: z.number() }) }),
          },
        },
      },
    })
    const binding = defineFallbackBinding(contract, {
      snapshotEvent: 'stateChanged',
      version: { ofSnapshot: (s) => s.revision },
    })
    expect(binding.config.snapshotToEvents?.({ revision: 7 })).toEqual([
      { event: 'stateChanged', data: { revision: 7 } },
    ])
  })

  it('requires exactly one of snapshotToEvents / snapshotEvent', () => {
    expect(() =>
      defineFallbackBinding(uploadStatusContract, {
        version: { ofSnapshot: (s) => s.version },
      }),
    ).toThrow(/exactly one/)
  })

  it('stamps the binding on the contract for server-side introspection', () => {
    const binding = defineFallbackBinding(uploadStatusContract, {
      snapshotToEvents: () => [],
      version: { ofSnapshot: (s) => s.version },
    })
    expect(readFallbackBinding(uploadStatusContract)).toBe(binding)
    // Non-enumerable: never serialized, never seen by Fastify.
    expect(Object.keys(uploadStatusContract)).not.toContain('binding')
    expect(
      JSON.parse(JSON.stringify({ ...uploadStatusContract, pathResolver: undefined })),
    ).toBeDefined()
  })

  it('serializes query params and passes headers/body through', () => {
    const binding = defineFallbackBinding(uploadStatusContract, {
      snapshotToEvents: () => [],
      version: { ofSnapshot: (s) => s.version },
    })
    const request = binding.buildSnapshotRequest({
      pathParams: { uploadId: 'u1' },
      queryParams: { verbose: true, limit: 5, skip: undefined },
      headers: { 'x-tenant': 't1' },
    })
    expect(request.query).toEqual({ verbose: 'true', limit: '5' })
    expect(request.headers).toEqual({ 'x-tenant': 't1' })
  })
})

// ============================================================================
// bindFallbackContracts (escape hatch)
// ============================================================================

describe('bindFallbackContracts', () => {
  it('binds a separate poll + stream contract pair with param mapping', () => {
    const binding = bindFallbackContracts(plainPollContract, sseOnlyContract, {
      snapshotToEvents: (s) => [
        { event: 'update', data: { status: s.status, version: s.version } },
      ],
      version: { ofSnapshot: (s) => s.version, ofEvent: (e) => e.data.version },
    })

    expect(binding.buildSnapshotRequest({}).path).toBe('/jobs/current')
    expect(binding.buildStreamRequest({}).path).toBe('/jobs/stream')
    expect(readFallbackBinding(plainPollContract)).toBe(binding)
    expect(readFallbackBinding(sseOnlyContract)).toBe(binding)
  })

  it('rejects an SSE-capable poll contract', () => {
    expect(() =>
      bindFallbackContracts(uploadStatusContract, sseOnlyContract, {
        snapshotToEvents: () => [],
        version: 'none',
      }),
    ).toThrow(/plain \(non-SSE\) contract/)
  })

  it('rejects a stream contract without SSE responses', () => {
    expect(() =>
      bindFallbackContracts(plainPollContract, plainPollContract, {
        snapshotToEvents: () => [],
        version: 'none',
      }),
    ).toThrow(/SSE success response/)
  })

  it('applies mapParams to each side independently', () => {
    const binding = bindFallbackContracts(plainPollContract, sseOnlyContract, {
      snapshotToEvents: () => [],
      version: 'none',
      mapParams: {
        toStream: (params) => ({ ...params, queryParams: { channel: 'jobs' } }),
      },
    })
    expect(binding.buildSnapshotRequest({ queryParams: { a: '1' } }).query).toEqual({ a: '1' })
    expect(binding.buildStreamRequest({ queryParams: { a: '1' } }).query).toEqual({
      channel: 'jobs',
    })
  })
})

// ============================================================================
// fromLegacyDualModeContract
// ============================================================================

describe('fromLegacyDualModeContract', () => {
  // Structural legacy contract (buildSseContract output shape) — avoids
  // depending on the legacy builder at runtime.
  const legacyContract = {
    method: 'get' as const,
    pathResolver: (p: { jobId: string }) => `/jobs/${p.jobId}/status`,
    isSSE: true as const,
    isDualMode: true as const,
    successResponseBodySchema: z.object({ status: z.string(), version: z.number() }),
    serverSentEventSchemas: {
      done: z.object({ result: z.string() }),
    },
  }

  it('accepts a legacy dual-mode contract', () => {
    const binding = fromLegacyDualModeContract(legacyContract, {
      snapshotToEvents: (s) => {
        expectTypeOf(s.version).toEqualTypeOf<number>()
        return s.status === 'done' ? [{ event: 'done', data: { result: s.status } }] : []
      },
      version: { ofSnapshot: (s) => s.version },
      terminalEvents: ['done'],
    })
    expect(binding.buildStreamRequest({ pathParams: { jobId: 'j1' } }).path).toBe('/jobs/j1/status')
  })

  it('rejects non-dual legacy contracts', () => {
    expect(() =>
      fromLegacyDualModeContract(
        { ...legacyContract, isDualMode: false as unknown as true },
        { snapshotToEvents: () => [], version: 'none' },
      ),
    ).toThrow(/legacy dual-mode contract/)
  })
})

// ============================================================================
// FallbackEvent typing
// ============================================================================

describe('FallbackEvent typing', () => {
  it('is a discriminated union over event names', () => {
    type Events = { a: { x: number }; b: { y: string } }
    const handle = (e: FallbackEvent<Events>) => {
      if (e.event === 'a') {
        expectTypeOf(e.data).toEqualTypeOf<{ x: number }>()
      } else {
        expectTypeOf(e.data).toEqualTypeOf<{ y: string }>()
      }
    }
    handle({ event: 'a', data: { x: 1 }, origin: 'sse' })
  })
})
