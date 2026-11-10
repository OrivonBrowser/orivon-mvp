// Upstreams on loopback for the relay's tests: an HTTP CONNECT proxy (plain or over TLS) that records what it was asked, a
// SOCKS4 proxy, and a server that echoes. A name reaches a destination only through `targets`, which maps the address the
// relay was asked for (a documentation address no test reaches) to the local port that stands in for it. Not *.test.ts, so
// vitest does not collect it as a suite.

import { createServer } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'
import { connect as netConnect } from 'node:net'
import { createServer as createTlsServer } from 'node:tls'

export interface Started {
  readonly port: number
}

const open: Array<() => Promise<void>> = []

/** Closes everything started since the last call; a test file runs it after each test. */
export async function closeAll (): Promise<void> {
  while (open.length > 0) await open.pop()?.()
}

/** Listens on a free loopback port and arranges for the server and every connection to it to be closed. */
export async function listening (server: Server): Promise<number> {
  const sockets = new Set<Socket>()
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  open.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })
  return (server.address() as AddressInfo).port
}

/** A loopback port nothing listens on. */
export async function closedPort (): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  return port
}

/** Runs `close` at `closeAll`, for a server this module did not start. */
export function closeLater (close: () => Promise<void>): void {
  open.push(close)
}

/** Keeps a socket a test opened until `closeAll`. */
export function keep<T extends Socket> (socket: T): T {
  socket.on('error', () => {})
  open.push(async () => { socket.destroy() })
  return socket
}

/** A TCP server that writes back whatever it reads, and sends `greeting` first when given. */
export async function startEcho (greeting?: string): Promise<Started & { readonly connections: () => number }> {
  let connections = 0
  const server = createServer((socket) => {
    connections += 1
    if (greeting !== undefined) socket.write(greeting)
    socket.on('data', (chunk) => socket.write(chunk))
  })
  const port = await listening(server)
  return { port, connections: () => connections }
}

export interface SeenConnect {
  /** The request line as it arrived. */
  readonly requestLine: string
  /** Header names in lowercase. */
  readonly headers: Readonly<Record<string, string>>
}

export interface ConnectProxyOptions {
  /** `address:port` to the local port that stands in for it; any other destination is answered 502. */
  readonly targets?: Readonly<Record<string, number>>
  /** Answers every CONNECT with this status instead of tunnelling. */
  readonly status?: number
  /** Written in the same segment as the 200 answer, as a server that speaks first would. */
  readonly firstBytes?: string
  /** Accepts the connection and never answers. */
  readonly silent?: boolean
  /** Closes the connection after reading the request. */
  readonly hangUp?: boolean
  /** Answers with something that is not HTTP. */
  readonly garbage?: boolean
  /** Serves TLS with this key and certificate, as an HTTPS proxy does. */
  readonly tls?: { readonly key: string, readonly cert: string }
}

export interface ConnectProxy extends Started {
  /** One entry per request head, in order. */
  readonly seen: SeenConnect[]
}

export async function startConnectProxy (options: ConnectProxyOptions = {}): Promise<ConnectProxy> {
  const seen: SeenConnect[] = []
  const serve = (socket: Socket): void => {
    socket.on('error', () => {})
    let buffered = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.off('data', onData)
      const [requestLine = '', ...lines] = buffered.subarray(0, end).toString('latin1').split('\r\n')
      const headers: Record<string, string> = {}
      for (const line of lines) headers[line.slice(0, line.indexOf(':')).toLowerCase()] = line.slice(line.indexOf(':') + 1).trim()
      seen.push({ requestLine, headers })
      const early = buffered.subarray(end + 4)
      if (options.silent === true) return
      if (options.hangUp === true) { socket.destroy(); return }
      if (options.garbage === true) { socket.end('this is not http\r\n\r\n'); return }
      const authority = requestLine.split(' ')[1] ?? ''
      const target = options.targets?.[authority]
      const status = options.status ?? (target === undefined ? 502 : 200)
      if (status < 200 || status >= 300) { socket.end(`HTTP/1.1 ${String(status)} Refused\r\nContent-Length: 0\r\n\r\n`); return }
      if (target === undefined) { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return }
      const upstream = netConnect({ host: '127.0.0.1', port: target })
      upstream.on('error', () => { socket.destroy() })
      socket.on('close', () => upstream.destroy())
      upstream.once('connect', () => {
        socket.write(`HTTP/1.1 200 Connection established\r\n\r\n${options.firstBytes ?? ''}`)
        if (early.length > 0) upstream.write(early)
        socket.pipe(upstream)
        upstream.pipe(socket)
      })
    }
    socket.on('data', onData)
  }
  const server = options.tls === undefined
    ? createServer(serve)
    : createTlsServer({ key: options.tls.key, cert: options.tls.cert }, serve)
  const port = await listening(server)
  return { port, seen }
}

export interface Socks4Seen {
  readonly command: number
  readonly address: string
  readonly port: number
  readonly userId: string
}

export interface Socks4Proxy extends Started {
  readonly seen: Socks4Seen[]
}

/** A SOCKS4 proxy: `reply` is the code it answers with (90 granted, 91 failed, 92 or 93 the user id refused), and a granted one tunnels to `targets`. */
export async function startSocks4Proxy (options: { readonly targets?: Readonly<Record<string, number>>, readonly reply?: number } = {}): Promise<Socks4Proxy> {
  const seen: Socks4Seen[] = []
  const server = createServer((socket) => {
    socket.on('error', () => {})
    let buffered = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      const nul = buffered.indexOf(0, 8)
      if (buffered.length < 9 || nul === -1) return
      socket.off('data', onData)
      const address = [...buffered.subarray(4, 8)].join('.')
      const port = buffered.readUInt16BE(2)
      seen.push({ command: buffered[1] ?? 0, address, port, userId: buffered.subarray(8, nul).toString('latin1') })
      const target = options.targets?.[`${address}:${String(port)}`]
      const code = options.reply ?? (target === undefined ? 91 : 90)
      const answer = Buffer.from([0, code, 0, 0, 0, 0, 0, 0])
      if (code !== 90 || target === undefined) { socket.end(answer); return }
      const early = buffered.subarray(nul + 1)
      const upstream = netConnect({ host: '127.0.0.1', port: target })
      upstream.on('error', () => { socket.destroy() })
      socket.on('close', () => upstream.destroy())
      upstream.once('connect', () => {
        socket.write(answer)
        if (early.length > 0) upstream.write(early)
        socket.pipe(upstream)
        upstream.pipe(socket)
      })
    }
    socket.on('data', onData)
  })
  const port = await listening(server)
  return { port, seen }
}

/** Reads from `socket` until `count` bytes have come, or it ends. */
export async function readBytes (socket: Socket, count: number): Promise<string> {
  return await new Promise((resolve) => {
    let text = ''
    const finish = (): void => { socket.off('data', onData); socket.off('close', finish); resolve(text) }
    const onData = (chunk: Buffer): void => { text += chunk.toString('latin1'); if (text.length >= count) finish() }
    socket.on('data', onData)
    socket.once('close', finish)
    socket.resume()
  })
}
