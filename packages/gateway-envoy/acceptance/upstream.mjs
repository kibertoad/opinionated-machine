// Minimal upstream stub for acceptance tests.
//
// Echoes back the path, method, and a few headers the gateway forwards.
// Path "/slow" delays for the requested ms (driven by ?ms=X) so we can verify
// gateway timeouts.
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 8081)

/**
 * Accept negotiation matching the server's `determineMode()`: quality values
 * are honoured, so `text/event-stream;q=0` is a refusal rather than a request.
 */
function wantsStream(accept) {
  if (!accept) return false
  const ranges = accept
    .split(',')
    .map((part) => {
      const [mediaType, ...params] = part.trim().split(';')
      let quality = 1
      for (const param of params) {
        const [key, value] = param.trim().split('=')
        if (key === 'q' && value) quality = Number.parseFloat(value)
      }
      return { mediaType: (mediaType ?? '').trim().toLowerCase(), quality }
    })
    .filter((entry) => entry.quality > 0)
    .sort((a, b) => b.quality - a.quality)

  for (const { mediaType } of ranges) {
    if (mediaType === 'text/event-stream') return true
    if (mediaType === 'application/json') return false
  }
  return false
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

  if (url.pathname === '/slow') {
    const delay = Number(url.searchParams.get('ms') ?? '500')
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ path: url.pathname, delayedMs: delay }))
    }, delay)
    return
  }

  // Dual-mode stub: negotiates on Accept exactly like determineMode() does.
  // The SSE branch behaves like /sse; the JSON branch is deliberately slow so
  // the route timeout on the plain branch of the split has something to catch.
  if (url.pathname === '/dual') {
    if (wantsStream(req.headers.accept)) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('event: first\ndata: {"n":1}\n\n')
      const gap = Number(url.searchParams.get('gapMs') ?? '3000')
      const timer = setTimeout(() => {
        res.write('event: second\ndata: {"n":2}\n\n')
        res.end()
      }, gap)
      res.on('close', () => clearTimeout(timer))
      return
    }
    const delay = Number(url.searchParams.get('ms') ?? '0')
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ path: url.pathname, branch: 'json', delayedMs: delay }))
    }, delay)
    return
  }

  // SSE stub: first event immediately, second after ?gapMs (default 3000),
  // then the stream ends. The idle gap between the two events is what the
  // streaming-route acceptance tests use to trip (or survive) idle timeouts.
  if (url.pathname.startsWith('/sse')) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    })
    res.write('event: first\ndata: {"n":1}\n\n')
    const gap = Number(url.searchParams.get('gapMs') ?? '3000')
    const timer = setTimeout(() => {
      res.write('event: second\ndata: {"n":2}\n\n')
      res.end()
    }, gap)
    res.on('close', () => clearTimeout(timer))
    return
  }

  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: {
        'x-trace-id': req.headers['x-trace-id'] ?? null,
        'x-internal': req.headers['x-internal'] ?? null,
      },
    }),
  )
}).listen(PORT, () => {
  console.log(`[upstream] listening on :${PORT}`)
})
