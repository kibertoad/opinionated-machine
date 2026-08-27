import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineApiContract, sseBody } from '@lokalise/api-contracts'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v4'
import {
  createEventIdSequence,
  defineEvent,
  type EventIdSequence,
  SSERoomBroadcaster,
  SSERoomManager,
} from '../../index.js'
import { buildApiRoute, getSessionRooms } from '../../lib/api-contracts/index.ts'
import {
  createResilientSubscription,
  defineFallbackBinding,
  type FallbackPolicy,
  type FallbackTransport,
} from '../../packages/sse-fallback/src/index.ts'
import { createSSETestServer, type SSETestServerWithResources } from '../sseTestServerFactory.js'

/**
 * End-to-end integration of @opinionated-machine/sse-fallback against the
 * real server machinery: a dual-mode `buildApiRoute` route whose sync branch
 * answers polls from a job store while its SSE branch joins a room that a
 * "domain service" broadcasts into with monotonic event ids.
 */

// ---------------------------------------------------------------------------
// Server fixtures
// ---------------------------------------------------------------------------

type Job = { status: 'pending' | 'completed'; result?: string; version: number }

const progressEvent = defineEvent('progress', z.object({ percent: z.number() }))
const doneEvent = defineEvent('done', z.object({ result: z.string() }))

const jobContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Job status (dual-mode)',
  pathResolver: ({ jobId }) => `/api/fallback-jobs/${jobId}`,
  requestPathParamsSchema: z.object({ jobId: z.string() }),
  responsesByStatusCode: {
    200: {
      content: {
        'application/json': z.object({
          status: z.enum(['pending', 'completed']),
          result: z.string().optional(),
          version: z.number(),
        }),
        'text/event-stream': sseBody({
          progress: z.object({ percent: z.number() }),
          done: z.object({ result: z.string() }),
        }),
      },
    },
  },
})

const jobBinding = defineFallbackBinding(jobContract, {
  snapshotToEvents: (s) =>
    s.status === 'completed' ? [{ event: 'done', data: { result: s.result as string } }] : [],
  version: { ofSnapshot: (s) => s.version },
  terminalEvents: ['done'],
})

/** In-memory job store + broadcaster — the "domain service" side. */
class JobService {
  private readonly jobs = new Map<string, Job>()
  private readonly sequences = new Map<string, EventIdSequence>()
  private readonly broadcaster: SSERoomBroadcaster

  constructor(broadcaster: SSERoomBroadcaster) {
    this.broadcaster = broadcaster
  }

  create(jobId: string): void {
    this.jobs.set(jobId, { status: 'pending', version: 0 })
    this.sequences.set(jobId, createEventIdSequence({ epoch: '0' }))
  }

  get(jobId: string): Job {
    return this.jobs.get(jobId) ?? { status: 'pending', version: 0 }
  }

  private nextVersion(jobId: string): { version: number; id: string } {
    const job = this.jobs.get(jobId) as Job
    job.version += 1
    const seq = this.sequences.get(jobId) as EventIdSequence
    return { version: job.version, id: seq.next() }
  }

  async progress(jobId: string, percent: number): Promise<void> {
    const { version } = this.nextVersion(jobId)
    // Stamp the raw version as the SSE id so the client's default
    // `Number(id)` version extraction lines up with the snapshot version.
    await this.broadcaster.broadcastToRoom(
      `job:${jobId}`,
      progressEvent,
      { percent },
      {
        id: String(version),
      },
    )
  }

  async complete(jobId: string, result: string): Promise<void> {
    const job = this.jobs.get(jobId) as Job
    const { version } = this.nextVersion(jobId)
    job.status = 'completed'
    job.result = result
    await this.broadcaster.broadcastToRoom(
      `job:${jobId}`,
      doneEvent,
      { result },
      {
        id: String(version),
      },
    )
  }
}

// ---------------------------------------------------------------------------
// Fetch-based transport (what frontend-http-client would implement)
// ---------------------------------------------------------------------------

function createFetchTransport(baseUrl: string): FallbackTransport {
  const toUrl = (request: { path: string; query?: Record<string, string> }) => {
    const url = new URL(request.path, baseUrl)
    for (const [key, value] of Object.entries(request.query ?? {})) {
      url.searchParams.set(key, value)
    }
    return url
  }

  return {
    async fetchSnapshot(request, { signal }) {
      const response = await fetch(toUrl(request), {
        method: request.method.toUpperCase(),
        headers: { accept: 'application/json', ...request.headers },
        signal,
      })
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.json().catch(() => undefined),
      }
    },
    async openStream(request, { signal, lastEventId }) {
      const response = await fetch(toUrl(request), {
        method: request.method.toUpperCase(),
        headers: {
          accept: 'text/event-stream',
          ...(lastEventId !== undefined ? { 'last-event-id': lastEventId } : {}),
          ...request.headers,
        },
        signal,
      })
      const body = response.body
      const chunks = (async function* (): AsyncGenerator<string, void, unknown> {
        if (!body) return
        const reader = body.getReader()
        const decoder = new TextDecoder()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) return
            yield decoder.decode(value, { stream: true })
          }
        } finally {
          reader.releaseLock()
        }
      })()
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        chunks,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const FAST_POLICY: Partial<FallbackPolicy> = {
  deadmanDelayMs: 400,
  deadmanIdleBackoff: { factor: 1, maxMs: 400 },
  staleConnectionTimeoutMs: 'off',
  sseRetryBackoff: { baseMs: 50, factor: 1, maxMs: 50 },
  pollFailureBackoff: { baseMs: 50, factor: 1, maxMs: 50 },
}

describe('sse-fallback integration (real server, real HTTP)', () => {
  let server: SSETestServerWithResources<undefined>
  let broadcaster: SSERoomBroadcaster
  let jobService: JobService

  beforeEach(async () => {
    const sseRoomManager = new SSERoomManager()
    broadcaster = new SSERoomBroadcaster({ sseRoomManager })
    jobService = new JobService(broadcaster)

    server = await createSSETestServer(
      (app) => {
        app.route(
          buildApiRoute(
            jobContract,
            (request, _reply, { expectedContentType, sse }) => {
              if (expectedContentType === 'text/event-stream') {
                const session = sse.start('keepAlive')
                getSessionRooms(session).join(`job:${request.params.jobId}`)
                return
              }
              return {
                status: 200,
                contentType: 'application/json',
                body: jobService.get(request.params.jobId),
              }
            },
            { sseRooms: broadcaster },
          ),
        )
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => undefined,
      },
    )
  })

  afterEach(async () => {
    await server.close()
  })

  it('delivers the completion over SSE push (happy path)', { timeout: 10000 }, async () => {
    jobService.create('j1')
    const sub = createResilientSubscription(jobBinding, {
      transport: createFetchTransport(server.baseUrl),
      params: { pathParams: { jobId: 'j1' } },
      policy: FAST_POLICY,
    })
    try {
      const completion = sub.waitFor('done', { timeoutMs: 5000 })
      // Wait for the SSE branch to join the room, then push.
      await vi.waitFor(() => {
        expect(broadcaster.getConnectionCountInRoom('job:j1')).toBe(1)
      })
      await jobService.progress('j1', 50)
      await jobService.complete('j1', 'pushed-result')

      await expect(completion).resolves.toEqual({ result: 'pushed-result' })
      expect(sub.status).toBe('stopped')
    } finally {
      sub.stop()
    }
  })

  it(
    'closes the startup race: a job completed before subscribing resolves via the eager poll',
    { timeout: 10000 },
    async () => {
      jobService.create('j2')
      await jobService.complete('j2', 'already-done')

      const sub = createResilientSubscription(jobBinding, {
        transport: createFetchTransport(server.baseUrl),
        params: { pathParams: { jobId: 'j2' } },
        policy: FAST_POLICY,
      })
      try {
        const delivered = await sub.waitFor('done', { timeoutMs: 5000 })
        expect(delivered).toEqual({ result: 'already-done' })
      } finally {
        sub.stop()
      }
    },
  )

  it(
    'delivers the completion via the deadman poll when the push is missed',
    { timeout: 10000 },
    async () => {
      jobService.create('j3')
      const origins: string[] = []
      const sub = createResilientSubscription(jobBinding, {
        transport: createFetchTransport(server.baseUrl),
        params: { pathParams: { jobId: 'j3' } },
        policy: FAST_POLICY,
      })
      sub.onEvent((event) => origins.push(event.origin))
      try {
        const completion = sub.waitFor('done', { timeoutMs: 8000 })
        await vi.waitFor(() => {
          expect(broadcaster.getConnectionCountInRoom('job:j3')).toBe(1)
        })

        // Simulate a missed notification: the job completes but the broadcast
        // targets a room nobody re-broadcasts (local-only miss) — here we just
        // mutate the store without broadcasting.
        const job = jobService.get('j3')
        job.status = 'completed'
        job.result = 'polled-result'
        job.version += 1

        await expect(completion).resolves.toEqual({ result: 'polled-result' })
        expect(origins.at(-1)).toBe('poll')
      } finally {
        sub.stop()
      }
    },
  )

  it(
    'survives a silently-dead stream via the stale watchdog and still completes',
    { timeout: 15000 },
    async () => {
      jobService.create('j4')
      const sub = createResilientSubscription(jobBinding, {
        transport: createFetchTransport(server.baseUrl),
        params: { pathParams: { jobId: 'j4' } },
        policy: {
          ...FAST_POLICY,
          // No heartbeats arrive within 700ms (plugin default is 30s), so the
          // watchdog force-closes and reconnects — the original incident class.
          staleConnectionTimeoutMs: 700,
          deadmanDelayMs: 60_000, // keep the deadman out of this test
          deadmanIdleBackoff: { factor: 1, maxMs: 60_000 },
        },
      })
      try {
        const completion = sub.waitFor('done', { timeoutMs: 10_000 })

        // First connection joins, gets force-closed by the watchdog, and the
        // client reconnects — wait until the server has seen a NEW connection
        // after the old one left.
        await vi.waitFor(() => {
          expect(broadcaster.getConnectionCountInRoom('job:j4')).toBe(1)
        })
        await vi.waitFor(
          () => {
            expect(sub.status === 'reconnecting' || sub.status === 'live').toBe(true)
          },
          { timeout: 5000 },
        )

        // Eventually a (re)connected stream is in the room; push the completion.
        await vi.waitFor(
          () => {
            expect(broadcaster.getConnectionCountInRoom('job:j4')).toBeGreaterThanOrEqual(1)
          },
          { timeout: 5000 },
        )
        await jobService.complete('j4', 'after-reconnect')

        await expect(completion).resolves.toEqual({ result: 'after-reconnect' })
      } finally {
        sub.stop()
      }
    },
  )
})

// ---------------------------------------------------------------------------
// Browser-safety guard for the sse-fallback package sources
// ---------------------------------------------------------------------------

describe('sse-fallback browser safety', () => {
  it('has no node:/fastify/server-only imports in its source tree', () => {
    const srcDir = join(__dirname, '..', '..', 'packages', 'sse-fallback', 'src')
    const offenders: string[] = []
    for (const file of readdirSync(srcDir)) {
      if (!file.endsWith('.ts') || file.endsWith('.spec.ts')) continue
      const content = readFileSync(join(srcDir, file), 'utf8')
      for (const forbidden of ["from 'node:", "from 'fastify", "from 'awilix", 'require(']) {
        if (content.includes(forbidden)) {
          offenders.push(`${file}: ${forbidden}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
