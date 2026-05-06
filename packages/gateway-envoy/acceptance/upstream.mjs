// Minimal upstream stub for acceptance tests.
//
// Echoes back the path, method, and a few headers the gateway forwards.
// Path "/slow" delays for the requested ms (driven by ?ms=X) so we can verify
// gateway timeouts.
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 8081)

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
