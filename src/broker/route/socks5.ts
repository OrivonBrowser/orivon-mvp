// A route provider over a SOCKS5 proxy, built on the `socks` package: CONNECT
// with the destination as a name, UDP ASSOCIATE, no name resolution (SOCKS5
// has no standard command for one). The greeting offers "no authentication"
// and, when credentials are given, username/password, so a proxy that takes
// none still works and one that isolates by credentials gets them.

import { createHash, createHmac, randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import type { Socket as DgramSocket } from 'node:dgram'
import { connect as netConnect, isIP } from 'node:net'
import type { Socket } from 'node:net'
import { SocksClient } from 'socks'
import type { SocksClientOptions } from 'socks'
import { fail } from '../errors.js'
import type { RoutedDatagram, RoutedUdp, RouteProvider } from './provider.js'

export interface Socks5Credentials {
  readonly userId: string
  readonly password: string
}

export interface Socks5ProviderOptions {
  readonly host: string
  readonly port: number
  /** Sent in the greeting as username/password, next to "no authentication". */
  readonly credentials?: Socks5Credentials
  /** Bounds the connection to the proxy and its handshake. */
  readonly timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Credentials that differ per app and per run: the user name is a hash of the
 * key, the password an HMAC of it under a secret made for this run. A proxy
 * that isolates streams by credentials (Tor's default) then gives each app its
 * own circuits, and none of them can be linked across runs.
 */
export function isolationCredentials (runSecret: Uint8Array = randomBytes(32)): (key: string) => Socks5Credentials {
  return (key) => ({
    userId: createHash('sha256').update(key).digest('hex').slice(0, 32),
    password: createHmac('sha256', runSecret).update(key).digest('hex').slice(0, 32)
  })
}

/** Closing the relay cannot reject on its own; a listener that throws is the only way, and it must not end the browser. */
function reportCloseFailure (error: unknown): void {
  console.error('[route] closing the datagram relay failed:', error)
}

/**
 * Whether the proxy itself answered a failed connect: it refused to carry the stream (host unreachable, connection
 * refused, a rule), which says nothing against the route. A proxy that cannot be reached, closes at once or fails the
 * sign-in is not one that answered.
 */
export function routeAnswered (error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Socks5 proxy rejected connection')
}

function abandoned (): Error {
  return fail('revoked', 'the connection was abandoned')
}

/** The TCP connection to the proxy itself. Its address is the person's own setting, so it is resolved here like any local program would. */
function connectToProxy (options: Socks5ProviderOptions, signal: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abandoned()); return }
    const socket = netConnect({ host: options.host, port: options.port })
    const timer = setTimeout(() => { socket.destroy(Object.assign(new Error('the proxy did not answer'), { code: 'ETIMEDOUT' })) }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const onAbort = (): void => { socket.destroy(); settle(); reject(abandoned()) }
    const settle = (): void => { clearTimeout(timer); signal.removeEventListener('abort', onAbort) }
    signal.addEventListener('abort', onAbort, { once: true })
    socket.once('error', (error) => { settle(); reject(error) })
    socket.once('connect', () => { settle(); resolve(socket) })
  })
}

/** What the package reports once a handshake is done: the proxy connection, and for ASSOCIATE the relay's address. */
interface Established {
  readonly socket: Socket
  readonly remoteHost?: { readonly host: string, readonly port: number }
}

interface ReceiveBufferLike {
  readonly length: number
  get: (length: number) => Buffer
}

/**
 * Bytes the proxy sent after its reply, in the same segment or right behind
 * it, are the target's first words (a server that speaks first). The package
 * re-emits what it buffered and then resumes the stream in a later turn, which
 * drops them when nothing listens yet. They are taken here, held until that
 * turn has passed, and pushed back in front of the stream, so the first read
 * sees them in order. The socket it returns is paused.
 */
async function keepEarlyBytes (client: SocksClient, socket: Socket): Promise<void> {
  const held: Buffer[] = []
  const hold = (chunk: Buffer): void => { held.push(chunk) }
  // The package's own handlers are gone by now and the caller's are not yet
  // there, so an error in this window would be uncaught; the close that
  // follows it reaches the caller's wrapper.
  const ignore = (): void => {}
  socket.on('error', ignore)
  const buffered = (client as unknown as { receiveBuffer?: ReceiveBufferLike }).receiveBuffer
  if (buffered !== undefined && buffered.length > 0) held.push(buffered.get(buffered.length))
  socket.on('data', hold)
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  socket.off('data', hold)
  socket.off('error', ignore)
  socket.pause()
  if (held.length > 0 && !socket.destroyed) socket.unshift(Buffer.concat(held))
}

/** Runs the SOCKS5 handshake for `command` over `socket`, a connection already open to the proxy. */
async function handshake (
  socket: Socket,
  options: Socks5ProviderOptions,
  command: 'connect' | 'associate',
  destination: { host: string, port: number },
  signal: AbortSignal
): Promise<Established> {
  if (signal.aborted) {
    socket.destroy()
    throw abandoned()
  }
  const clientOptions: SocksClientOptions = {
    proxy: {
      host: options.host,
      port: options.port,
      type: 5,
      ...(options.credentials === undefined ? {} : { userId: options.credentials.userId, password: options.credentials.password })
    },
    command,
    destination,
    existing_socket: socket,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }
  const client = new SocksClient(clientOptions)
  const onAbort = (): void => { socket.destroy() }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const info = await new Promise<Established>((resolve, reject) => {
      client.once('established', resolve)
      client.once('error', reject)
      client.connect(socket)
    })
    if (command === 'connect') await keepEarlyBytes(client, socket)
    return info
  } catch (error) {
    socket.destroy()
    throw signal.aborted ? abandoned() : error
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function listenersOf<T> (): { add: (listener: T) => void, each: (call: (listener: T) => void) => void } {
  const all: T[] = []
  return { add: (listener) => { all.push(listener) }, each: (call) => { for (const listener of all) call(listener) } }
}

/** Whether the proxy is on this computer, so the datagram socket stays on loopback too. */
function proxyIsLocal (address: string): boolean {
  return address === '127.0.0.1' || address === '::1'
}

async function openUdp (options: Socks5ProviderOptions, signal: AbortSignal): Promise<RoutedUdp> {
  const control = await connectToProxy(options, signal)
  // The socket is bound before the request is made, and its port is the one the request declares: a relay that knows which
  // port is the client's takes datagrams from that port alone, and no other program on this computer can use the association.
  const peer = control.remoteAddress ?? options.host
  const proxyFamily6 = isIP(peer) === 6
  const local = proxyIsLocal(peer) ? (proxyFamily6 ? '::1' : '127.0.0.1') : (proxyFamily6 ? '::' : '0.0.0.0')
  const socket: DgramSocket = createSocket(proxyFamily6 ? 'udp6' : 'udp4')
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.bind(0, local, () => { socket.off('error', reject); resolve() })
    })
  } catch (error) {
    control.destroy()
    try { socket.close() } catch { /* never bound */ }
    throw error
  }
  let established: Established
  try {
    established = await handshake(control, options, 'associate', { host: local, port: socket.address().port }, signal)
  } catch (error) {
    try { socket.close() } catch { /* already closed */ }
    throw error
  }
  const relayPort = established.remoteHost?.port ?? 0
  // An address that is no address, or the unspecified one, means "where you reached me".
  const reported = established.remoteHost?.host ?? ''
  const relayHost = isIP(reported) === 0 || reported === '0.0.0.0' || reported === '::' ? control.remoteAddress ?? options.host : reported
  if (relayPort === 0 || (isIP(relayHost) === 6) !== proxyFamily6) {
    control.destroy()
    try { socket.close() } catch { /* already closed */ }
    throw fail('unreachable', relayPort === 0 ? 'the proxy gave no address for datagrams' : 'the proxy answered with datagram address of another family than the one it was reached on')
  }
  const datagramListeners = listenersOf<(datagram: RoutedDatagram) => void>()
  const closeListeners = listenersOf<() => void>()
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    control.destroy()
    await new Promise<void>((resolve) => { try { socket.close(() => { resolve() }) } catch { resolve() } })
    closeListeners.each((listener) => { listener() })
  }
  control.once('close', () => { close().catch(reportCloseFailure) })
  control.on('error', () => {})
  // Connected, the socket is told by ICMP when the relay refused a datagram: that datagram is lost, the channel is not.
  socket.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'ECONNREFUSED') close().catch(reportCloseFailure) })
  // The relay is the only sender accepted: the socket is connected to it below,
  // and the check stays for the moment before that.
  socket.on('message', (message, from) => {
    if (from.address !== relayHost || from.port !== relayPort) return
    try {
      const frame = SocksClient.parseUDPFrame(message)
      if (frame.frameNumber !== 0) return
      datagramListeners.each((listener) => { listener({ host: frame.remoteHost.host, port: frame.remoteHost.port, data: new Uint8Array(frame.data) }) })
    } catch {
      // A frame that does not parse is dropped, like any lost datagram.
    }
  })
  try {
    // Connected to the relay, the kernel itself drops a datagram from any other sender.
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.connect(relayPort, relayHost, () => { socket.off('error', reject); resolve() })
    })
  } catch (error) {
    await close()
    throw error
  }

  return {
    send: async (datagram) => {
      if (closed) throw fail('closed', 'the datagram channel is closed')
      const frame = SocksClient.createUDPFrame({ remoteHost: { host: datagram.host, port: datagram.port }, data: Buffer.from(datagram.data) })
      await new Promise<void>((resolve, reject) => {
        socket.send(frame, (error) => { if (error === null || error === undefined) resolve(); else reject(error) })
      })
    },
    onDatagram: datagramListeners.add,
    onClose: closeListeners.add,
    close
  }
}

export function createSocks5Provider (options: Socks5ProviderOptions): RouteProvider {
  return {
    connect: async (host, port, signal) => {
      const socket = await connectToProxy(options, signal)
      const established = await handshake(socket, options, 'connect', { host, port }, signal)
      return established.socket
    },
    udp: async (signal) => await openUdp(options, signal)
  }
}
