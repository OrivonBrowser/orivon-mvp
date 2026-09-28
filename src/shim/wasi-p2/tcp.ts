// wasi:sockets/tcp over orivon.net. WASI's calls never block: a connect,
// bind or listen is started, answered `would-block` until orivon.net
// settles, and finished once the socket's pollable is ready. orivon.net binds
// and listens in one call, so a bind is recorded and made at listen, where
// an address in use is reported.

import type { TcpServer, TcpSocket as OrivonTcpSocket } from '../../contracts/handles.js'
import {
  type IpAddressFamily, type IpSocketAddress, type ResolvedNames, type SocketNet,
  addressOf, isUnspecified, reportedAddress, scopeOf, socketErrorCode
} from './addresses.js'
import { InputStream, OutputStream, Pollable } from './io.js'

type State = 'unbound' | 'bind-started' | 'bound' | 'connect-started' | 'connected' | 'listen-started' | 'listening' | 'closed'
type ShutdownType = 'receive' | 'send' | 'both'
type Connection = [TcpSocket, InputStream, OutputStream]

/** A change any pollable of the socket may be waiting on. */
class Signal {
  #waiters: Array<() => void> = []

  wait (): Promise<void> {
    return new Promise((resolve) => { this.#waiters.push(resolve) })
  }

  notify (): void {
    const waiters = this.#waiters
    this.#waiters = []
    waiters.forEach((wake) => { wake() })
  }
}

/** The streams of a connected orivon.net socket. */
function streamsOf (socket: OrivonTcpSocket): { input: InputStream, output: OutputStream, reader: ReadableStreamDefaultReader<Uint8Array>, writer: WritableStreamDefaultWriter<Uint8Array> } {
  const reader = socket.readable.getReader()
  const writer = socket.writable.getWriter()
  const input = new InputStream(async () => {
    const { done, value } = await reader.read()
    return done ? new Uint8Array(0) : value
  }, socketErrorCode)
  const output = new OutputStream(async (bytes) => { await writer.write(bytes) }, socketErrorCode)
  return { input, output, reader, writer }
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
  #pending: 'running' | 'done' | { readonly code: string } | undefined
  #socket: OrivonTcpSocket | undefined
  #server: TcpServer | undefined
  #streams: ReturnType<typeof streamsOf> | undefined
  readonly #accepted: Connection[] = []
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

  #checkFamily (address: IpSocketAddress): void {
    if (address.tag !== this.#family) throw 'invalid-argument'
  }

  /** Runs `work` as the pending operation: finish-* answers would-block until it settles. */
  #start (work: Promise<void>): void {
    this.#pending = 'running'
    work.then(
      () => { this.#pending = 'done' },
      (error: unknown) => { this.#pending = { code: socketErrorCode(error) } }
    ).finally(() => { this.#signal.notify() })
  }

  /** Throws would-block while the pending operation runs, or its error once it failed. */
  #finish (): void {
    const pending = this.#pending
    if (pending === undefined) throw 'not-in-progress'
    if (pending === 'running') throw 'would-block'
    this.#pending = undefined
    if (pending !== 'done') {
      this.#state = 'closed'
      throw pending.code
    }
  }

  startBind (_network: unknown, localAddress: IpSocketAddress): void {
    this.#expect('unbound')
    this.#checkFamily(localAddress)
    this.#local = localAddress
    this.#state = 'bind-started'
    this.#pending = 'done'
  }

  finishBind (): void {
    this.#expect('bind-started')
    this.#finish()
    this.#state = 'bound'
  }

  startConnect (_network: unknown, remoteAddress: IpSocketAddress): void {
    this.#expect('unbound', 'bound')
    this.#checkFamily(remoteAddress)
    const address = addressOf(remoteAddress)
    if (remoteAddress.val.port === 0 || isUnspecified(address)) throw 'invalid-argument'
    this.#state = 'connect-started'
    this.#start(this.#context.net.connect({ host: this.#context.names.hostFor(address), port: remoteAddress.val.port })
      .then((socket) => { this.#socket = socket }))
  }

  finishConnect (): [InputStream, OutputStream] {
    this.#expect('connect-started')
    this.#finish()
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
    this.#state = 'listen-started'
    this.#start(this.#context.net.listen({ port: local.val.port, scope: scopeOf(addressOf(local)) })
      .then((server) => { this.#server = server }))
  }

  finishListen (): void {
    this.#expect('listen-started')
    this.#finish()
    this.#state = 'listening'
    void this.#pumpConnections()
  }

  /** Queues each accepted connection as it arrives, so accept() can answer at once. */
  async #pumpConnections (): Promise<void> {
    const server = this.#server
    if (server === undefined) return
    const reader = server.connections.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const socket = new TcpSocket(this.#context, this.#family, value)
        const streams = socket.#connectedStreams()
        this.#accepted.push([socket, streams.input, streams.output])
        this.#signal.notify()
      }
    } catch {}
  }

  accept (): Connection {
    this.#expect('listening')
    const next = this.#accepted.shift()
    if (next === undefined) throw 'would-block'
    return next
  }

  localAddress (): IpSocketAddress {
    if (this.#socket !== undefined) return reportedAddress(this.#socket.localAddress, this.#socket.localPort, this.#family)
    if (this.#server !== undefined) return reportedAddress(this.#server.localAddress, this.#server.localPort, this.#family)
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
    if (this.#state === 'listening') return this.#accepted.length > 0
    return true
  }

  shutdown (how: ShutdownType): void {
    this.#expect('connected')
    const streams = this.#connectedStreams()
    if (how !== 'send') void streams.reader.cancel().catch(() => {})
    if (how !== 'receive') void streams.writer.close().catch(() => {})
  }

  [Symbol.dispose] (): void {
    this.#state = 'closed'
    void this.#socket?.close().catch(() => {})
    void this.#server?.close().catch(() => {})
  }
}
