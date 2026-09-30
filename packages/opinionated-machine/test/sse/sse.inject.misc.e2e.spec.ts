import { describe, expect, it } from 'vitest'
import { SSEInjectConnection } from '../../index.js'

describe('SSE Inject E2E (SSEInjectConnection timeout paths)', () => {
  it('waitForEvent throws on timeout', async () => {
    // Create connection with no events (empty body)
    const connection = new SSEInjectConnection({
      statusCode: 200,
      headers: {},
      body: '',
    })

    await expect(connection.waitForEvent('nonexistent', 10)).rejects.toThrow(
      'Timeout waiting for event: nonexistent',
    )
  })

  it('waitForEvents throws on timeout when not enough events', async () => {
    // Create connection with only 1 event
    const connection = new SSEInjectConnection({
      statusCode: 200,
      headers: {},
      body: 'event: test\ndata: {}\n\n',
    })

    await expect(connection.waitForEvents(5, 10)).rejects.toThrow(
      'Timeout waiting for 5 events, received 1',
    )
  })
})

describe('SSE Inject E2E (SSEInjectConnection body accessors)', () => {
  it('getBody returns the raw response body', () => {
    const connection = new SSEInjectConnection({
      statusCode: 200,
      headers: {},
      body: 'event: test\ndata: {}\n\n',
    })

    expect(connection.getBody()).toBe('event: test\ndata: {}\n\n')
  })

  it('json parses a JSON body', () => {
    const connection = new SSEInjectConnection({
      statusCode: 503,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ errorCode: 'INTEGRATION_NOT_AVAILABLE' }),
    })

    expect(connection.json()).toEqual({ errorCode: 'INTEGRATION_NOT_AVAILABLE' })
  })

  it('json throws on an empty body', () => {
    const connection = new SSEInjectConnection({
      statusCode: 204,
      headers: {},
      body: '',
    })

    expect(() => connection.json()).toThrow('json() — response body is empty (status 204)')
  })

  it('json throws on a non-JSON body, including a body snippet', () => {
    const connection = new SSEInjectConnection({
      statusCode: 200,
      headers: {},
      body: 'event: test\ndata: {}\n\n',
    })

    expect(() => connection.json()).toThrow(/json\(\) — body is not valid JSON: .*event: test/s)
  })

  it('json truncates a long body in the error message', () => {
    const connection = new SSEInjectConnection({
      statusCode: 500,
      headers: {},
      body: 'x'.repeat(600),
    })

    expect(() => connection.json()).toThrow('…')
  })
})
