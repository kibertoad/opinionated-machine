import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { bindBodyForStatus } from '../../lib/testing/sseInjectHelpers.js'
import type { SSEResponse } from '../../lib/testing/sseTestTypes.js'

/**
 * Direct unit coverage for `bindBodyForStatus` — the failure branches
 * (invalid JSON, schema mismatch, no declared schema, truncation) are
 * awkward to drive deterministically through a real server, so they are
 * exercised here against synthetic `closed` results.
 */

const errorSchemas = {
  401: z.object({ message: z.string() }),
}

const resolved = (res: Partial<SSEResponse>): Promise<SSEResponse> =>
  Promise.resolve({ statusCode: 200, headers: {}, body: '', ...res })

describe('bindBodyForStatus', () => {
  it('returns the parsed body on the happy path', async () => {
    const bodyForStatus = bindBodyForStatus(
      { responseBodySchemasByStatusCode: errorSchemas },
      resolved({ statusCode: 401, body: JSON.stringify({ message: 'Unauthorized' }) }),
    )

    await expect(bodyForStatus(401)).resolves.toEqual({ message: 'Unauthorized' })
  })

  it('throws when the actual status does not match the expected one', async () => {
    const bodyForStatus = bindBodyForStatus(
      { responseBodySchemasByStatusCode: errorSchemas },
      resolved({ statusCode: 500, body: 'boom' }),
    )

    await expect(bodyForStatus(401)).rejects.toThrow(/bodyForStatus\(401\) — actual status 500/)
  })

  it('throws when no schema is declared for the matched status', async () => {
    const bodyForStatus = bindBodyForStatus(
      { responseBodySchemasByStatusCode: {} },
      resolved({ statusCode: 404, body: '{}' }),
    )

    await expect(bodyForStatus(404 as never)).rejects.toThrow(
      /no response body schema declared for status 404/,
    )
  })

  it('throws a contextual error when the body is not valid JSON', async () => {
    const bodyForStatus = bindBodyForStatus(
      { responseBodySchemasByStatusCode: errorSchemas },
      resolved({ statusCode: 401, body: 'not-json' }),
    )

    await expect(bodyForStatus(401)).rejects.toThrow(/body is not valid JSON/)
  })

  it('throws a contextual error when the body fails schema validation', async () => {
    const bodyForStatus = bindBodyForStatus(
      { responseBodySchemasByStatusCode: errorSchemas },
      resolved({ statusCode: 401, body: JSON.stringify({ message: 42 }) }),
    )

    await expect(bodyForStatus(401)).rejects.toThrow(/does not match the declared schema/)
  })

  it('truncates an oversized body in the error message', async () => {
    const bodyForStatus = bindBodyForStatus(
      { responseBodySchemasByStatusCode: errorSchemas },
      resolved({ statusCode: 401, body: 'x'.repeat(2000) }),
    )

    const error = await bodyForStatus(401).catch((err: Error) => err)
    expect(error.message).toContain('…')
    expect(error.message.length).toBeLessThan(2000)
  })

  it('does not split a surrogate pair when truncating', async () => {
    // The emoji straddles the truncation boundary (code units 499/500).
    const bodyForStatus = bindBodyForStatus(
      { responseBodySchemasByStatusCode: errorSchemas },
      resolved({ statusCode: 401, body: `${'x'.repeat(499)}😀${'y'.repeat(100)}` }),
    )

    const error = await bodyForStatus(401).catch((err: Error) => err)
    // The snippet must not end in a lone (unpaired) high surrogate.
    expect(error.message).not.toMatch(/[\ud800-\udbff]…/)
  })
})
