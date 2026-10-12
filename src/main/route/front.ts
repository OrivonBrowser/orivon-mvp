// The loopback HTTP proxy Chromium is pointed at for a routed app. Chromium cannot authenticate to a SOCKS proxy, and
// Node already has an HTTP server, so this one turns Chromium's CONNECT and absolute-form requests into
// `provider.connect(host, port)` on the app's route and does nothing else: no local name resolution, no direct dial,
// and no answer for a caller that lacks the secret. Electron-free; README.md says why it exists.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { RouteProvider } from '../../broker/route/provider.js'

export interface RouteFront {
  readonly port: number
  /** The user name Chromium sends with the secret; fixed, since the secret is what identifies the caller. */
  readonly username: string
  /** Random per front and never stored: it exists in this process only. */
  readonly secret: string
  /** Ends every tunnel and forwarded request in flight; the front keeps answering new ones. */
  closeTunnels: () => void
  close: () => Promise<void>
}

export interface RouteFrontOptions {
  /** Read on every request, so a changed proxy applies to the next one. Undefined means the app has no proxy to go through, and the front refuses. */
  readonly provider: () => RouteProvider | undefined
  /** Testing only. */
  readonly secret?: string
}

const USERNAME = 'orivon'
const PROXY_AUTHENTICATE = 'Basic realm="orivon-route"'
/** Hop-by-hop headers and the credentials of this hop: none reaches the target. */
const NOT_FORWARDED = new Set(['proxy-authorization', 'proxy-connection', 'proxy-authenticate', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade'])

function same (a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** `host:port` as a CONNECT line writes it, or undefined for anything else. */
function parseAuthority (text: string): { host: string, port: number } | undefined {
  const split = text.lastIndexOf(':')
  if (split <= 0) return undefined
  const portText = text.slice(split + 1)
  if (!/^\d{1,5}$/.test(portText)) return undefined
  const port = Number(portText)
  let host = text.slice(0, split)
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (port < 1 || host === '' || !/^[A-Za-z0-9.:_-]+$/.test(host)) return undefined
  return port > 65535 ? undefined : { host, port }
}

/** `http://host[:port]/path` as a proxy request line carries it, or undefined for any other form: a proxy forwards absolute http requests and nothing else. */
function absoluteHttpTarget (text: string): { host: string, port: number, authority: string, path: string } | undefined {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' || url.hostname === '' || url.username !== '' || url.password !== '') return undefined
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  return { host, port: url.port === '' ? 80 : Number(url.port), authority: url.host, path: `${url.pathname}${url.search}` }
}

function refuse (socket: Duplex, status: string, extraHeaders = ''): void {
  socket.end(`HTTP/1.1 ${status}\r\n${extraHeaders}Connection: close\r\nContent-Length: 0\r\n\r\n`)
}

export async function startRouteFront (options: RouteFrontOptions): Promise<RouteFront> {
  const secret = options.secret ?? randomBytes(24).toString('hex')
  const expected = `Basic ${Buffer.from(`${USERNAME}:${secret}`).toString('base64')}`
  const live = new Set<Duplex>()
  const authorised = (req: IncomingMessage): boolean => {
    const given = req.headers['proxy-authorization']
    return typeof given === 'string' && same(given, expected)
  }
  const track = (...sockets: Duplex[]): void => {
    for (const socket of sockets) {
      live.add(socket)
      socket.once('close', () => { live.delete(socket) })
    }
  }

  /** The stream to `host:port` through the app's route, or the status line that says why there is none. */
  async function open (host: string, port: number, signal: AbortSignal): Promise<{ socket: Socket } | { status: string }> {
    const provider = options.provider()
    if (provider === undefined) return { status: '503 Service Unavailable' }
    try {
      return { socket: await provider.connect(host, port, signal) }
    } catch {
      return { status: '502 Bad Gateway' }
    }
  }

  const server: Server = createServer((req, res) => {
    forward(req, res).catch(() => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy() })
  })

  server.on('connection', (socket) => {
    socket.on('error', () => {})
    track(socket)
  })

  server.on('connect', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => {})
    if (!authorised(req)) { refuse(socket, '407 Proxy Authentication Required', `Proxy-Authenticate: ${PROXY_AUTHENTICATE}\r\n`); return }
    const target = parseAuthority(req.url ?? '')
    if (target === undefined) { refuse(socket, '400 Bad Request'); return }
    // Read from the start, so the client giving up is heard while the route is still connecting, and anything it sends
    // early is kept for the tunnel.
    const early: Buffer[] = head.length > 0 ? [head] : []
    const keepEarly = (chunk: Buffer): void => { early.push(chunk) }
    socket.on('data', keepEarly)
    const abandoned = new AbortController()
    const onClose = (): void => { abandoned.abort() }
    // The server accepts half-open connections, so a client that hung up is first heard as 'end'.
    socket.once('close', onClose)
    socket.once('end', onClose)
    open(target.host, target.port, abandoned.signal).then((opened) => {
      socket.off('close', onClose)
      socket.off('end', onClose)
      socket.off('data', keepEarly)
      if ('status' in opened) { refuse(socket, opened.status); return }
      const upstream = opened.socket
      if (socket.destroyed) { upstream.destroy(); return }
      track(upstream)
      upstream.on('error', () => { socket.destroy() })
      socket.on('close', () => { upstream.destroy() })
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (early.length > 0) upstream.write(Buffer.concat(early))
      upstream.pipe(socket)
      socket.pipe(upstream)
    }).catch(() => { socket.destroy() })
  })

  async function forward (req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorised(req)) {
      res.writeHead(407, { 'Proxy-Authenticate': PROXY_AUTHENTICATE, Connection: 'close', 'Content-Length': 0 }).end()
      return
    }
    const target = absoluteHttpTarget(req.url ?? '')
    if (target === undefined) {
      res.writeHead(400, { Connection: 'close', 'Content-Length': 0 }).end()
      return
    }
    const abandoned = new AbortController()
    res.once('close', () => { abandoned.abort() })
    const opened = await open(target.host, target.port, abandoned.signal)
    if ('status' in opened) {
      res.writeHead(Number.parseInt(opened.status, 10), { Connection: 'close', 'Content-Length': 0 }).end()
      return
    }
    const carrier = opened.socket
    track(carrier)
    // A client that gave up leaves nothing open on the route.
    res.once('close', () => { if (!res.writableFinished) carrier.destroy() })

    // Headers the client named in `Connection` describe its hop, not the target's.
    const named = new Set(String(req.headers.connection ?? '').split(',').map((token) => token.trim().toLowerCase()).filter((token) => token !== ''))
    const headers: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(req.headers)) if (value !== undefined && !NOT_FORWARDED.has(name) && !named.has(name)) headers[name] = value
    headers.connection = 'close'
    // The address in the request line is the destination, whatever Host says.
    headers.host = target.authority
    const upstream = httpRequest({ createConnection: () => carrier, host: target.host, port: target.port, method: req.method, path: target.path, headers })
    upstream.on('response', (answer) => {
      const forwarded: string[] = []
      for (let index = 0; index + 1 < answer.rawHeaders.length; index += 2) {
        const name = answer.rawHeaders[index] ?? ''
        if (!NOT_FORWARDED.has(name.toLowerCase())) forwarded.push(name, answer.rawHeaders[index + 1] ?? '')
      }
      res.writeHead(answer.statusCode ?? 502, answer.statusMessage, forwarded)
      answer.pipe(res)
    })
    upstream.on('error', () => {
      if (res.headersSent) res.destroy()
      else res.writeHead(502, { Connection: 'close', 'Content-Length': 0 }).end()
    })
    // A route hands its stream over paused (the provider's contract); the request reads it from here on.
    upstream.on('socket', (socket) => { socket.resume() })
    req.pipe(upstream)
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo

  const closeTunnels = (): void => { for (const socket of [...live]) socket.destroy() }
  return {
    port,
    username: USERNAME,
    secret,
    closeTunnels,
    close: async () => {
      closeTunnels()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  }
}
