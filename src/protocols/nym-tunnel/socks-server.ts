// A SOCKS5 server on loopback that carries each client's streams and datagrams through that client's own Nym
// tunnel (instances.ts). Username/password only, the password being the secret main made for this start; CONNECT by
// name or address, and UDP ASSOCIATE with the relay on loopback. No BIND and no other method. README.md's Design
// notes say why this is written here and not taken from a package.

import { timingSafeEqual } from 'node:crypto'
import { createSocket } from 'node:dgram'
import type { Socket as DgramSocket } from 'node:dgram'
import { createServer, isIPv6 } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'
import { SocksClient } from 'socks'
import { AcquireError } from './instances.js'
import type { Lease, TcpStream, UdpChannel } from './instances.js'
import { USER_NAME } from './protocol.js'

const CLIENT_ADDRESS = '127.0.0.1'
const VERSION = 0x05
const AUTH_VERSION = 0x01
const METHOD_PASSWORD = 0x02
const METHOD_NONE_ACCEPTABLE = 0xff
const COMMAND_CONNECT = 0x01
const COMMAND_ASSOCIATE = 0x03
const REPLY_OK = 0x00
const REPLY_NOT_ALLOWED = 0x02
const REPLY_HOST_UNREACHABLE = 0x04
const REPLY_COMMAND_NOT_SUPPORTED = 0x07
const REPLY_ADDRESS_NOT_SUPPORTED = 0x08

/** A client that has not finished the handshake by now is dropped. */
const HANDSHAKE_TIMEOUT_MS = 10_000
/** Connections that have signed in and asked for something; one that has not is counted apart, so a flood of those takes no slot from them. */
const MAX_CONNECTIONS = 512
const MAX_UNAUTHENTICATED = 32
/** What a client may have sent that has not been read yet: a handshake is a few hundred bytes, and more waits in the kernel, not here. */
const MAX_UNREAD_BYTES = 16 * 1024
/** How long a datagram receive waits before the association is looked at again: a closed channel cannot wake one. */
const RECEIVE_SLICE_MS = 5_000
const MAX_RECEIVE_ERRORS = 5

export interface SocksServerDeps {
  /** The password every client must send. */
  readonly secret: string
  readonly acquire: (userName: string) => Promise<Lease>
  /** How long a stream may take to open through a tunnel; the module's own limit is not always the end of a connect that hangs. */
  readonly connectTimeoutMs?: number
  /** How long a stream is kept after its client has sent all it will send, without a byte from the far end; the module cannot pass that on (README.md). */
  readonly halfCloseGraceMs?: number
  /** Why a client was refused a tunnel the server could not give, for the status line. */
  readonly onRefused?: (userName: string, error: AcquireError) => void
}

export interface SocksServer {
  readonly port: number
  close: () => Promise<void>
}

/** Whether `given` is `secret`. The comparison takes the same time wherever the two differ; only their lengths, which are fixed and not secret, may end it early. */
export function sameSecret (given: string, secret: string): boolean {
  const presented = Buffer.from(given, 'utf8')
  const expected = Buffer.from(secret, 'utf8')
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}

/** Bytes a connection has received and not yet been asked for. */
class Reader {
  private buffered = Buffer.alloc(0)
  private ended = false
  private wake: (() => void) | undefined
  private held = false

  constructor (private readonly socket: Socket) {
    socket.on('data', this.onData)
    // A client that is gone before it has asked for anything gives its place back at once, not when the handshake times out.
    socket.on('end', this.onEnd)
    socket.on('close', this.onEnd)
    socket.on('error', this.onEnd)
  }

  private readonly onData = (chunk: Buffer): void => {
    this.buffered = Buffer.concat([this.buffered, chunk])
    // A client that sends more than it is asked for is slowed, not buffered: the rest stays in the kernel.
    if (this.buffered.length > MAX_UNREAD_BYTES && !this.held) { this.held = true; this.socket.pause() }
    this.wake?.()
  }

  private readonly onEnd = (): void => {
    this.ended = true
    this.wake?.()
  }

  async read (count: number): Promise<Buffer> {
    while (this.buffered.length < count) {
      if (this.ended) throw new Error('the client closed the connection')
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
    const out = this.buffered.subarray(0, count)
    this.buffered = this.buffered.subarray(count)
    if (this.held && this.buffered.length <= MAX_UNREAD_BYTES) { this.held = false; this.socket.resume() }
    return out
  }

  /** Stops listening and hands over what came after the last read. */
  release (): Buffer {
    this.socket.off('data', this.onData)
    this.held = false
    const rest = this.buffered
    this.buffered = Buffer.alloc(0)
    return rest
  }
}

interface Destination {
  readonly host: string
  readonly port: number
}

/** Control characters, space and the characters that make a name something else (a path, a user): never part of a host name. */
function isForbiddenInName (character: string): boolean {
  const code = character.charCodeAt(0)
  return code <= 0x20 || code === 0x7f || character === '/' || character === '@'
}

async function readDestination (reader: Reader, addressType: number): Promise<Destination | undefined> {
  let host: string
  if (addressType === 0x01) {
    host = [...await reader.read(4)].join('.')
  } else if (addressType === 0x03) {
    const length = (await reader.read(1))[0] ?? 0
    host = (await reader.read(length)).toString('utf8')
    if (host === '' || [...host].some(isForbiddenInName)) return undefined
  } else if (addressType === 0x04) {
    const bytes = await reader.read(16)
    const groups: string[] = []
    for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16))
    host = groups.join(':')
    if (!isIPv6(host)) return undefined
  } else {
    return undefined
  }
  return { host, port: (await reader.read(2)).readUInt16BE(0) }
}

function reply (code: number, bound: { address: string, port: number } = { address: '0.0.0.0', port: 0 }): Buffer {
  const out = Buffer.alloc(10)
  out[0] = VERSION
  out[1] = code
  out[3] = 0x01
  bound.address.split('.').forEach((part, index) => { out[4 + index] = Number(part) })
  out.writeUInt16BE(bound.port, 8)
  return out
}

function describe (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What a connection is for, once its handshake is done. */
interface Request {
  readonly userName: string
  readonly command: number
  readonly destination: Destination
  readonly reader: Reader
}

async function handshake (socket: Socket, reader: Reader, secret: string): Promise<Request | undefined> {
  const greeting = await reader.read(2)
  if (greeting[0] !== VERSION) return undefined
  const methods = await reader.read(greeting[1] ?? 0)
  if (!methods.includes(METHOD_PASSWORD)) { socket.end(Buffer.from([VERSION, METHOD_NONE_ACCEPTABLE])); return undefined }
  socket.write(Buffer.from([VERSION, METHOD_PASSWORD]))

  if ((await reader.read(1))[0] !== AUTH_VERSION) return undefined
  const userName = (await reader.read((await reader.read(1))[0] ?? 0)).toString('utf8')
  const presented = (await reader.read((await reader.read(1))[0] ?? 0)).toString('utf8')
  if (!USER_NAME.test(userName) || !sameSecret(presented, secret)) { socket.end(Buffer.from([AUTH_VERSION, 0x01])); return undefined }
  socket.write(Buffer.from([AUTH_VERSION, 0x00]))

  const head = await reader.read(4)
  if (head[0] !== VERSION) return undefined
  const command = head[1] ?? 0
  const destination = await readDestination(reader, head[3] ?? 0)
  if (destination === undefined) { socket.end(reply(REPLY_ADDRESS_NOT_SUPPORTED)); return undefined }
  return { userName, command, destination, reader }
}

export const CONNECT_TIMEOUT_MS = 45_000
/** Quiet time after a client's end before its stream is closed: a client that closed for good and one waiting for its answer look the same. */
export const HALF_CLOSE_GRACE_MS = 10_000

/** The stream, or a refusal after `ms`; a stream that arrives after that is closed, not left open. */
async function openStream (lease: Lease, destination: Destination, ms: number): Promise<TcpStream> {
  const opening = lease.tunnel.connectTcp(destination.host, destination.port)
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error('the connection through Nym took too long')) }, ms) })
  try {
    return await Promise.race([opening, expired])
  } catch (error) {
    opening.then(async (late) => { await late.close() }, () => {}).catch(() => {})
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function connect (socket: Socket, request: Request, lease: Lease, limits: { connectTimeoutMs: number, halfCloseGraceMs: number }): Promise<void> {
  let stream: TcpStream
  try {
    stream = await openStream(lease, request.destination, limits.connectTimeoutMs)
  } catch {
    lease.release()
    socket.end(reply(REPLY_HOST_UNREACHABLE))
    return
  }
  if (socket.destroyed) {
    lease.release()
    stream.close().catch(() => {})
    return
  }
  socket.write(reply(REPLY_OK))
  const early = request.reader.release()

  let closed = false
  let grace: ReturnType<typeof setTimeout> | undefined
  const finish = (): void => {
    if (closed) return
    closed = true
    clearTimeout(grace)
    lease.release()
    socket.destroy()
    stream.close().catch(() => {})
  }
  socket.on('close', finish)
  socket.on('error', finish)

  let queue = Promise.resolve()
  const send = (bytes: Buffer): void => {
    queue = queue.then(async () => { if (!closed) await stream.write(new Uint8Array(bytes)) }).catch(finish)
  }
  if (early.length > 0) send(early)
  socket.on('data', (chunk: Buffer) => {
    send(chunk)
    // One chunk waits in the queue at a time, so a fast client cannot fill this process with bytes the mixnet has not taken.
    socket.pause()
    queue = queue.then(() => { if (!closed) socket.resume() })
  })
  // Closing the write side of a Nym stream ends its reading too (measured), so the client's end is not passed on: the
  // answer it is waiting for is still read, and the stream is closed once the far end ends or the grace is over.
  let clientEnded = false
  const arm = (): void => {
    clearTimeout(grace)
    grace = setTimeout(finish, limits.halfCloseGraceMs)
    grace.unref()
  }
  socket.on('end', () => { clientEnded = true; arm() })
  socket.resume()

  try {
    for (;;) {
      const chunk = await stream.read()
      if (chunk === null || closed) break
      if (clientEnded) arm()
      if (!socket.write(chunk)) await new Promise<void>((resolve) => { socket.once('drain', resolve); socket.once('close', resolve) })
    }
  } catch {
    // The stream ended in error: the client sees a closed connection.
  }
  finish()
}

/**
 * `clientPort` is the port the client declared in its request, on this computer: the only one whose datagrams the relay passes
 * on and the only one it answers. A client that declares none is refused before this runs.
 */
async function associate (control: Socket, lease: Lease, clientPort: number): Promise<void> {
  let channel: UdpChannel
  try {
    channel = await lease.tunnel.bindUdp()
  } catch {
    lease.release()
    control.end(reply(REPLY_HOST_UNREACHABLE))
    return
  }
  const relay: DgramSocket = createSocket('udp4')
  let closed = false
  const finish = (): void => {
    if (closed) return
    closed = true
    channel.close()
    try { relay.close() } catch { /* never bound */ }
    lease.release()
    control.destroy()
  }
  try {
    await new Promise<void>((resolve, reject) => {
      relay.once('error', reject)
      relay.bind(0, '127.0.0.1', () => { relay.off('error', reject); resolve() })
    })
  } catch {
    finish()
    return
  }
  if (control.destroyed) { finish(); return }
  relay.on('error', finish)
  control.on('close', finish)
  control.on('end', finish)
  control.on('error', finish)
  control.on('data', () => {})
  control.resume()
  control.write(reply(REPLY_OK, { address: '127.0.0.1', port: relay.address().port }))

  // The client's datagrams come from the port it declared, on loopback; a datagram from any other sender is not the client's.
  relay.on('message', (message, from) => {
    if (from.address !== CLIENT_ADDRESS || from.port !== clientPort) return
    try {
      const frame = SocksClient.parseUDPFrame(message)
      if (frame.frameNumber !== 0) return
      channel.sendTo(frame.remoteHost.host, frame.remoteHost.port, new Uint8Array(frame.data)).catch(() => {})
    } catch {
      // A frame that does not parse is dropped, like any lost datagram.
    }
  })

  let failures = 0
  while (!closed) {
    try {
      const datagram = await channel.recv(RECEIVE_SLICE_MS)
      failures = 0
      if (closed) continue
      const frame = SocksClient.createUDPFrame({ remoteHost: { host: datagram.host, port: datagram.port }, data: Buffer.from(datagram.data) })
      relay.send(frame, clientPort, CLIENT_ADDRESS)
    } catch (error) {
      if (closed || describe(error).includes('closed')) break
      if (describe(error).includes('timed out')) continue
      failures += 1
      if (failures >= MAX_RECEIVE_ERRORS) break
      await new Promise<void>((resolve) => { setTimeout(resolve, 200) })
    }
  }
  finish()
}

/** `signedIn` is called once the client has signed in and asked for something: false when the server is full of such connections. */
async function serve (socket: Socket, deps: SocksServerDeps, signedIn: () => boolean): Promise<void> {
  const reader = new Reader(socket)
  const timer = setTimeout(() => { socket.destroy() }, HANDSHAKE_TIMEOUT_MS)
  let request: Request | undefined
  try {
    request = await handshake(socket, reader, deps.secret)
  } catch {
    socket.destroy()
    return
  } finally {
    clearTimeout(timer)
  }
  if (request === undefined) {
    // A handshake that ended without a reply must not leave the connection open: it would hold one of the server's slots for ever.
    socket.end()
    setTimeout(() => { socket.destroy() }, 2_000).unref()
    return
  }
  if (!signedIn()) { socket.destroy(); return }
  // What the client sends before the tunnel is up waits in the kernel, not in this process.
  socket.pause()
  if (request.command !== COMMAND_CONNECT && request.command !== COMMAND_ASSOCIATE) { socket.resume(); socket.end(reply(REPLY_COMMAND_NOT_SUPPORTED)); return }
  // A relay that does not know which port is the client's would take the first datagram for it, from any program on this computer.
  if (request.command === COMMAND_ASSOCIATE && request.destination.port === 0) { socket.resume(); socket.end(reply(REPLY_NOT_ALLOWED)); return }

  let lease: Lease
  try {
    lease = await deps.acquire(request.userName)
  } catch (error) {
    if (error instanceof AcquireError) deps.onRefused?.(request.userName, error)
    // A refusal is an answer; a tunnel that did not come up is a connection that dies, which the route reads as down.
    if (error instanceof AcquireError && error.kind === 'cap') socket.end(reply(REPLY_NOT_ALLOWED))
    else socket.destroy()
    return
  }
  if (socket.destroyed) { lease.release(); return }
  if (request.command === COMMAND_CONNECT) await connect(socket, request, lease, { connectTimeoutMs: deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS, halfCloseGraceMs: deps.halfCloseGraceMs ?? HALF_CLOSE_GRACE_MS })
  else await associate(socket, lease, request.destination.port)
}

export async function startSocksServer (port: number, deps: SocksServerDeps): Promise<SocksServer> {
  const open = new Set<Socket>()
  /** Connections still signing in and connections that have signed in, counted apart: a flood of the first takes no place from the second. */
  const counts = { unauthenticated: 0, authenticated: 0 }
  // Half-open, so a client that has sent all it will send still receives the answer.
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    if (counts.unauthenticated >= MAX_UNAUTHENTICATED) { socket.destroy(); return }
    counts.unauthenticated += 1
    let gaveBack = false
    open.add(socket)
    socket.on('close', () => {
      open.delete(socket)
      if (!gaveBack) counts.unauthenticated -= 1
    })
    socket.on('error', () => {})
    const signedIn = (): boolean => {
      gaveBack = true
      counts.unauthenticated -= 1
      if (counts.authenticated >= MAX_CONNECTIONS) return false
      counts.authenticated += 1
      socket.once('close', () => { counts.authenticated -= 1 })
      return true
    }
    serve(socket, deps, signedIn).catch((error: unknown) => {
      console.error('[nym-tunnel] a SOCKS5 connection failed:', describe(error))
      socket.destroy()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      for (const socket of open) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  }
}

