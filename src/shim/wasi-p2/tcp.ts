// wasi:sockets/tcp over orivon.net. WASI's calls never block: a connect,
// bind or listen is started, answered `would-block` until orivon.net
// settles, and finished once the socket's pollable is ready. orivon.net binds
// and listens in one call, so a bind is recorded and made at listen, where
// an address in use is reported.

import type { TcpServer, TcpSocket as OrivonTcpSocket } from '../../contracts/handles.js'
import {
  type IpAddressFamily, type IpSocketAddress, type ResolvedNames, type SocketNet,
  addressGot, addressOf, isIpv4Mapped, isUnspecified, networkCode, reportedAddress, scopeOf, socketAddressOf, socketFailure
} from './addresses.js'
import { InputStream, OutputStream, Pollable, Signal } from './io.js'
import { openAtScope } from '../bind-scope.js'

type State = 'unbound' | 'bind-started' | 'bound' | 'connect-started' | 'connected' | 'listen-started' | 'listening' | 'closed'
type ShutdownType = 'receive' | 'send' | 'both'
type Connection = [TcpSocket, InputStream, OutputStream]

/** Connections accepted ahead of the program; past this, the listener waits before taking more. */
const DEFAULT_BACKLOG = 128

/** A failure as the socket throws it: a revoked grant stays a termination, which unwinds the component. */
function rethrow (error: unknown): never {
  const failure = socketFailure(error)
  throw typeof failure === 'string' ? error : failure
}

/** The streams of a connected orivon.net socket. `wrote()` reports whether the program has ever handed this socket a byte -- see [Symbol.dispose]'s own doc for why. */
function streamsOf (socket: OrivonTcpSocket): { input: InputStream, output: OutputStream, reader: ReadableStreamDefaultReader<Uint8Array>, writer: WritableStreamDefaultWriter<Uint8Array>, wrote: () => boolean } {
  const reader = socket.readable.getReader()
  const writer = socket.writable.getWriter()
  let wrote = false
  const input = new InputStream(async () => {
    const { done, value } = await reader.read().catch(rethrow)
    return done ? new Uint8Array(0) : value
  }, networkCode)
  const output = new OutputStream(async (bytes) => {
    wrote = true
    await writer.write(bytes).catch(rethrow)
  }, networkCode)
  return { input, output, reader, writer, wrote: () => wrote }
}

export interface TcpContext {
  readonly net: SocketNet
  readonly names: ResolvedNames
}

export class TcpSocket {
  readonly #context: TcpContext
  readonly #family: IpAddressFamily
  readonly #signal = new Signal()
  #state: State = 'unbound'
  #local: IpSocketAddress | undefined
  #pending: 'running' | 'done' | { readonly failure: unknown } | undefined
  #socket: OrivonTcpSocket | undefined
  #server: TcpServer | undefined
  #streams: ReturnType<typeof streamsOf> | undefined
  readonly #accepted: Connection[] = []
  /** Set once the listener's connections stream ends: accept then fails with it. */
  #listenFailure: unknown
  #backlog = DEFAULT_BACKLOG
  readonly #options = new Map<string, unknown>()

  constructor (context: TcpContext, family: IpAddressFamily, connected?: OrivonTcpSocket) {
    this.#context = context
    this.#family = family
    if (connected !== undefined) {
      this.#socket = connected
      this.#state = 'connected'
    }
  }

  #expect (...states: State[]): void {
    if (!states.includes(this.#state)) throw 'invalid-state'
  }

  #checkAddress (address: IpSocketAddress): void {
    if (address.tag !== this.#family || isIpv4Mapped(addressOf(address))) throw 'invalid-argument'
  }

  /** Runs `work` as the pending operation: finish-* answers would-block until it settles. */
  #start (work: Promise<void>): void {
    if (this.#pending === 'running') throw 'concurrency-conflict'
    this.#pending = 'running'
    work.then(
      () => { this.#pending = 'done' },
      (error: unknown) => { this.#pending = { failure: socketFailure(error) } }
    ).finally(() => { this.#signal.notify() })
  }

  /** The finish of `started`: not-in-progress unless it was started, would-block while it runs, its failure once it failed. */
  #finish (started: State): void {
    if (this.#state !== started) throw 'not-in-progress'
    const pending = this.#pending
    if (pending === 'running') throw 'would-block'
    this.#pending = undefined
    if (pending !== 'done' && pending !== undefined) {
      this.#state = 'closed'
      throw pending.failure
    }
  }

  /** Keeps what orivon.net hands back, unless the socket was dropped meanwhile: then it is closed, never leaked. */
  #adopt<T extends { close: () => Promise<void> }> (handle: T, keep: (handle: T) => void): void {
    if (this.#state === 'closed') void handle.close().catch(() => {})
    else keep(handle)
  }

  startBind (_network: unknown, localAddress: IpSocketAddress): void {
    this.#expect('unbound')
    this.#checkAddress(localAddress)
    this.#local = localAddress
    this.#state = 'bind-started'
    this.#pending = 'done'
  }

  finishBind (): void {
    this.#finish('bind-started')
    this.#state = 'bound'
  }

  startConnect (_network: unknown, remoteAddress: IpSocketAddress): void {
    this.#expect('unbound', 'bound')
    this.#checkAddress(remoteAddress)
    const address = addressOf(remoteAddress)
    if (remoteAddress.val.port === 0 || isUnspecified(address)) throw 'invalid-argument'
    this.#start(this.#context.net.connect({ host: this.#context.names.hostFor(address), port: remoteAddress.val.port })
      .then((socket) => { this.#adopt(socket, (kept) => { this.#socket = kept }) }))
    this.#state = 'connect-started'
  }

  finishConnect (): [InputStream, OutputStream] {
    this.#finish('connect-started')
    this.#state = 'connected'
    const streams = this.#connectedStreams()
    return [streams.input, streams.output]
  }

  #connectedStreams (): ReturnType<typeof streamsOf> {
    if (this.#socket === undefined) throw 'invalid-state'
    this.#streams ??= streamsOf(this.#socket)
    return this.#streams
  }

  startListen (): void {
    this.#expect('bound')
    const local = this.#local as IpSocketAddress
    this.#start(openAtScope((scope) => this.#context.net.listen({ port: local.val.port, scope }), scopeOf(addressOf(local)))
      .then((server) => { this.#adopt(server, (kept) => { this.#server = kept }) }))
    this.#state = 'listen-started'
  }

  /** Waits for the listen to settle rather than answering would-block, which wasi-libc's listen() takes as failure on a non-blocking socket. */
  async finishListen (): Promise<void> {
    if (this.#state !== 'listen-started') throw 'not-in-progress'
    while (this.#pending === 'running') await this.#signal.wait()
    this.#finish('listen-started')
    this.#state = 'listening'
    void this.#pumpConnections()
  }

  /** Queues each accepted connection as it arrives, up to the backlog, so accept() can answer at once. */
  async #pumpConnections (): Promise<void> {
    const server = this.#server
    if (server === undefined) return
    const reader = server.connections.getReader()
    try {
      for (;;) {
        while (this.#accepted.length >= this.#backlog && this.#state === 'listening') await this.#signal.wait()
        if (this.#state !== 'listening') break
        const { done, value } = await reader.read()
        if (done) { this.#listenFailure = 'invalid-state'; break }
        if (this.#state !== 'listening') { void value.close().catch(() => {}); break }
        const socket = new TcpSocket(this.#context, this.#family, value)
        const streams = socket.#connectedStreams()
        this.#accepted.push([socket, streams.input, streams.output])
        this.#signal.notify()
      }
    } catch (error) {
      this.#listenFailure = socketFailure(error)
    } finally {
      reader.releaseLock()
      this.#signal.notify()
    }
  }

  accept (): Connection {
    this.#expect('listening')
    const next = this.#accepted.shift()
    if (next !== undefined) {
      this.#signal.notify()
      return next
    }
    if (this.#listenFailure !== undefined) throw this.#listenFailure
    throw 'would-block'
  }

  localAddress (): IpSocketAddress {
    if (this.#socket !== undefined) return reportedAddress(this.#socket.localAddress, this.#socket.localPort, this.#family)
    if (this.#server !== undefined && this.#local !== undefined) return socketAddressOf(addressGot(addressOf(this.#local), this.#server.localAddress), this.#server.localPort)
    if (this.#local !== undefined && this.#state !== 'unbound') return this.#local
    throw 'invalid-state'
  }

  remoteAddress (): IpSocketAddress {
    this.#expect('connected')
    const socket = this.#socket as OrivonTcpSocket
    return reportedAddress(socket.remoteAddress, socket.remotePort, this.#family)
  }

  isListening (): boolean {
    return this.#state === 'listening'
  }

  addressFamily (): IpAddressFamily {
    return this.#family
  }

  setListenBacklogSize (value: bigint): void {
    if (value === 0n) throw 'invalid-argument'
    this.#backlog = Number(value < BigInt(DEFAULT_BACKLOG) ? value : BigInt(DEFAULT_BACKLOG))
  }

  keepAliveEnabled (): boolean { return this.#options.get('keepAlive') === true }
  setKeepAliveEnabled (value: boolean): void {
    this.#options.set('keepAlive', value)
    void this.#socket?.setKeepAlive(value).catch(() => {})
  }

  keepAliveIdleTime (): bigint { return this.#option('idle', 7_200_000_000_000n) }
  setKeepAliveIdleTime (value: bigint): void { this.#setOption('idle', value) }
  keepAliveInterval (): bigint { return this.#option('interval', 75_000_000_000n) }
  setKeepAliveInterval (value: bigint): void { this.#setOption('interval', value) }
  keepAliveCount (): number { return this.#option('count', 9) }
  setKeepAliveCount (value: number): void { this.#setOption('count', value) }
  hopLimit (): number { return this.#option('hopLimit', 64) }
  setHopLimit (value: number): void { this.#setOption('hopLimit', value) }
  receiveBufferSize (): bigint { return this.#option('receive', 65_536n) }
  setReceiveBufferSize (value: bigint): void { this.#setOption('receive', value) }
  sendBufferSize (): bigint { return this.#option('send', 65_536n) }
  setSendBufferSize (value: bigint): void { this.#setOption('send', value) }

  /** Options orivon.net does not expose are kept and reported back, as a host that cannot tune them may. */
  #option<T> (name: string, fallback: T): T {
    return this.#options.has(name) ? this.#options.get(name) as T : fallback
  }

  #setOption (name: string, value: bigint | number): void {
    if (value === 0 || value === 0n) throw 'invalid-argument'
    this.#options.set(name, value)
  }

  subscribe (): Pollable {
    return new Pollable(() => this.#isReady(), async () => { await this.#signal.wait() })
  }

  #isReady (): boolean {
    if (this.#pending === 'running') return false
    if (this.#state === 'listening') return this.#accepted.length > 0 || this.#listenFailure !== undefined
    return true
  }

  shutdown (how: ShutdownType): void {
    this.#expect('connected')
    const streams = this.#connectedStreams()
    if (how !== 'send') { streams.input.discard(); void streams.reader.cancel().catch(() => {}) }
    if (how !== 'receive') void streams.writer.close().catch(() => {})
  }

  /**
   * A program that wrote to this socket and then simply lets it go out of
   * scope -- no explicit shutdown() -- must not lose that output. Once the
   * program has handed this socket a byte, this closes the CONNECTION
   * THROUGH ITS OWN WRITABLE STREAM rather than through `this.#socket`'s
   * handle-level close(): that close() is a call to the Worker's separate
   * orivon control channel (../worker/orivon-client.ts/orivon-server.ts),
   * independent of the MessagePort relaying this stream's still-in-flight
   * writes across that same Worker boundary -- and was measured
   * (tests/tcp-dispose-race.test.ts) to reach the broker and end the real
   * socket before an already-"flushed" write had actually landed there,
   * silently dropping it. Closing through the writer instead keeps this
   * socket's own FIN strictly behind every write already queued on it,
   * because both travel the one channel the writer itself uses.
   *
   * A socket the program never wrote to (an unaccepted, queued connection
   * dropped along with its listener, say) has nothing to lose this way, so
   * it keeps the direct, immediate handle close.
   */
  [Symbol.dispose] (): void {
    this.#state = 'closed'
    this.#signal.notify()
    if (this.#streams?.wrote() === true) void this.#streams.writer.close().catch(() => {})
    else void this.#socket?.close().catch(() => {})
    void this.#server?.close().catch(() => {})
    for (const [socket] of this.#accepted.splice(0)) socket[Symbol.dispose]()
  }
}
