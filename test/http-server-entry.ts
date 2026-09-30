// Bundled against the shim by ./e2e-http-server.test.ts into the fixture app's
// page script: an ordinary Node app's own HTTP server, `http.createServer`
// listening on a loopback port for the app to use itself, and answering a
// request the page makes to it through the shim's own client.

import http from 'http'

export interface HttpServerStartResult {
  readonly listening?: boolean
  readonly address?: unknown
  readonly selfReply?: { readonly status: number | undefined, readonly served: string | string[] | undefined, readonly body: string }
  readonly error?: string
}

export interface HttpServerSeen {
  readonly method: string | undefined
  readonly url: string | undefined
  readonly body: string
  readonly remotePort: number | undefined
}

const seen: HttpServerSeen[] = []
let server: http.Server | undefined
;(globalThis as unknown as { httpServerProgress: string[] }).httpServerProgress = []
const progress = (globalThis as unknown as { httpServerProgress: string[] }).httpServerProgress

async function start (): Promise<HttpServerStartResult> {
  const port = (globalThis as unknown as { httpServerPort: number }).httpServerPort
  const created = http.createServer((req, res) => {
    const parts: Uint8Array[] = []
    req.on('data', (chunk: Uint8Array) => { parts.push(chunk) })
    req.on('end', () => {
      const body = parts.map((part) => new TextDecoder().decode(part)).join('')
      seen.push({ method: req.method, url: req.url, body, remotePort: req.socket?.remotePort })
      if (req.url === '/missing') { res.statusCode = 404; res.end('nothing here'); return }
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('X-Served-By', 'orivon-shim')
      res.end(JSON.stringify({ method: req.method, url: req.url, body }))
    })
  })
  server = created
  await new Promise<void>((resolve, reject) => {
    created.once('error', reject)
    created.listen(port, '127.0.0.1', resolve)
  })
  progress.push('listening')
  const selfReply = await new Promise<NonNullable<HttpServerStartResult['selfReply']>>((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/self?x=1', headers: { 'Content-Type': 'text/plain' } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, served: res.headers['x-served-by'], body }))
    })
    request.on('error', reject)
    request.end('from the page itself')
  })
  return { listening: created.listening, address: created.address(), selfReply }
}

async function stop (): Promise<{ closed: boolean, listening: boolean }> {
  const current = server
  if (current === undefined) return { closed: false, listening: false }
  current.closeAllConnections()
  await new Promise<void>((resolve) => { current.close(() => resolve()) })
  return { closed: true, listening: current.listening }
}

;(globalThis as unknown as { httpServerE2e: unknown }).httpServerE2e = {
  start: async () => { try { return await start() } catch (error) { return { error: String((error as Error)?.stack ?? error) } } },
  seen: () => seen,
  stop
}
