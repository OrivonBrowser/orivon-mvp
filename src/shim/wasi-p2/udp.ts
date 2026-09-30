// wasi:sockets/udp over orivon.net.udpBind. Datagrams that arrive are
// queued for receive(); sends are handed to orivon.net at once, a few in
// flight at a time, so neither call blocks.

import type { Datagram, UdpSocket as OrivonUdpSocket } from '../../contracts/handles.js'
import {
  type IpAddressFamily, type IpSocketAddress, type ResolvedNames, type SocketNet,
  addressOf, formatAddress, isIpv4Mapped, isUnspecified, reportedAddress, scopeOf, socketFailure
} from './addresses.js'
import { Pollable, Signal } from './io.js'
import { openAtScope } from '../bind-scope.js'

interface IncomingDatagram { data: Uint8Array, remoteAddress: IpSocketAddress }
interface OutgoingDatagram { data: Uint8Array, remoteAddress?: IpSocketAddress }

/** How many sends may be in flight before check-send answers zero. */
const SEND_WINDOW = 16
/** Datagrams queued for receive(); past this, new ones are dropped, as a full socket buffer drops them. */
const RECEIVE_QUEUE = 1024

function sameAddress (a: IpSocketAddress, b: IpSocketAddress): boolean {
  return a.val.port === b.val.port && formatAddress(addressOf(a)) === formatAddress(addressOf(b))
}

/** A remote address a datagram may go to: its family, not mapped, not unspecified, not port 0. */
function checkRemote (address: IpSocketAddress, family: IpAddressFamily): void {
  const ip = addressOf(address)
  if (address.tag !== family || isIpv4Mapped(ip) || isUnspecified(ip) || address.val.port === 0) throw 'invalid-argument'
}

export class IncomingDatagramStream {
  readonly #queue: IncomingDatagram[] = []
  readonly #signal = new Signal()
  #failure: unknown

  constructor (socket: OrivonUdpSocket, family: IpAddressFamily, remote: IpSocketAddress | undefined) {
    void (async () => {
      const reader = socket.readable.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          const from = reportedAddress(value.address, value.port, family)
          if ((remote !== undefined && !sameAddress(from, remote)) || this.#queue.length >= RECEIVE_QUEUE) continue
          this.#queue.push({ data: value.data, remoteAddress: from })
          this.#signal.notify()
        }
      } catch (error) {
        this.#failure = socketFailure(error)
        this.#signal.notify()
      }
    })()
  }

  receive (maxResults: bigint): IncomingDatagram[] {
    if (this.#queue.length === 0 && this.#failure !== undefined) throw this.#failure
    return this.#queue.splice(0, Number(maxResults))
  }

  subscribe (): Pollable {
    return new Pollable(() => this.#queue.length > 0 || this.#failure !== undefined, async () => { await this.#signal.wait() })
  }
}

export class OutgoingDatagramStream {
  readonly #writer: WritableStreamDefaultWriter<Datagram>
  readonly #names: ResolvedNames
  readonly #family: IpAddressFamily
  readonly #remote: IpSocketAddress | undefined
  readonly #signal = new Signal()
  #inFlight = 0
  #failure: unknown

  constructor (socket: OrivonUdpSocket, names: ResolvedNames, family: IpAddressFamily, remote: IpSocketAddress | undefined) {
    this.#writer = socket.writable.getWriter()
    this.#names = names
    this.#family = family
    this.#remote = remote
  }

  checkSend (): bigint {
    if (this.#failure !== undefined) throw this.#failure
    return BigInt(SEND_WINDOW - this.#inFlight)
  }

  /** Every datagram is checked before any is sent: once one has gone, send answers a count, never an error. */
  send (datagrams: readonly OutgoingDatagram[]): bigint {
    if (this.#failure !== undefined) throw this.#failure
    if (datagrams.length > SEND_WINDOW - this.#inFlight) throw new TypeError('a send exceeded what check-send permitted')
    const destinations = datagrams.map((datagram) => {
      const to = datagram.remoteAddress ?? this.#remote
      if (to === undefined) throw 'invalid-argument'
      if (this.#remote !== undefined && datagram.remoteAddress !== undefined && !sameAddress(to, this.#remote)) throw 'invalid-argument'
      checkRemote(to, this.#family)
      return to
    })
    datagrams.forEach((datagram, index) => {
      const to = destinations[index] as IpSocketAddress
      const address = addressOf(to)
      this.#inFlight++
      void this.#writer.write({ data: datagram.data.slice(), address: this.#names.hostFor(address), port: to.val.port, family: address.tag === 'ipv4' ? 'IPv4' : 'IPv6' })
        .catch((error: unknown) => { this.#failure = socketFailure(error) })
        .finally(() => {
          this.#inFlight--
          this.#signal.notify()
        })
    })
    return BigInt(datagrams.length)
  }

  subscribe (): Pollable {
    return new Pollable(() => this.#inFlight < SEND_WINDOW || this.#failure !== undefined, async () => { await this.#signal.wait() })
  }
}

type State = 'unbound' | 'bind-started' | 'bound' | 'closed'

export class UdpSocket {
  readonly #net: SocketNet
  readonly #names: ResolvedNames
  readonly #family: IpAddressFamily
  #state: State = 'unbound'
  #socket: OrivonUdpSocket | undefined
  #pending: Promise<void> | undefined
  #failure: unknown
  #remote: IpSocketAddress | undefined
  #streamed = false
  #hopLimit = 64
  readonly #buffers = new Map<string, bigint>()

  constructor (net: SocketNet, names: ResolvedNames, family: IpAddressFamily) {
    this.#net = net
    this.#names = names
    this.#family = family
  }

  startBind (_network: unknown, localAddress: IpSocketAddress): void {
    if (this.#state !== 'unbound') throw 'invalid-state'
    if (localAddress.tag !== this.#family || isIpv4Mapped(addressOf(localAddress))) throw 'invalid-argument'
    this.#state = 'bind-started'
    this.#pending = openAtScope((scope) => this.#net.udpBind({ port: localAddress.val.port, scope }), scopeOf(addressOf(localAddress))).then(
      (socket) => {
        // Dropped meanwhile: the port is let go rather than held until the child exits.
        if (this.#state === 'closed') void socket.close().catch(() => {})
        else this.#socket = socket
      },
      (error: unknown) => { this.#failure = socketFailure(error) }
    ).finally(() => { this.#pending = undefined })
  }

  /** Waits for the bind to settle rather than answering would-block, which wasi-libc's bind() takes as failure on a non-blocking socket. */
  async finishBind (): Promise<void> {
    if (this.#state !== 'bind-started') throw 'not-in-progress'
    await this.#pending
    if (this.#failure !== undefined) { this.#state = 'closed'; throw this.#failure }
    this.#state = 'bound'
  }

  /** A socket may be streamed once here: a second call would need orivon.net to rebind. */
  stream (remoteAddress: IpSocketAddress | undefined): [IncomingDatagramStream, OutgoingDatagramStream] {
    if (this.#state !== 'bound' || this.#socket === undefined) throw 'invalid-state'
    if (this.#streamed) throw 'not-supported'
    if (remoteAddress !== undefined) checkRemote(remoteAddress, this.#family)
    this.#streamed = true
    this.#remote = remoteAddress
    return [new IncomingDatagramStream(this.#socket, this.#family, remoteAddress), new OutgoingDatagramStream(this.#socket, this.#names, this.#family, remoteAddress)]
  }

  localAddress (): IpSocketAddress {
    if (this.#socket === undefined) throw 'invalid-state'
    return reportedAddress(this.#socket.localAddress, this.#socket.localPort, this.#family)
  }

  remoteAddress (): IpSocketAddress {
    if (this.#remote === undefined) throw 'invalid-state'
    return this.#remote
  }

  addressFamily (): IpAddressFamily { return this.#family }
  unicastHopLimit (): number { return this.#hopLimit }
  setUnicastHopLimit (value: number): void {
    if (value === 0) throw 'invalid-argument'
    this.#hopLimit = value
  }

  receiveBufferSize (): bigint { return this.#buffers.get('receive') ?? 65_536n }
  setReceiveBufferSize (value: bigint): void { this.#setBuffer('receive', value) }
  sendBufferSize (): bigint { return this.#buffers.get('send') ?? 65_536n }
  setSendBufferSize (value: bigint): void { this.#setBuffer('send', value) }

  #setBuffer (name: string, value: bigint): void {
    if (value === 0n) throw 'invalid-argument'
    this.#buffers.set(name, value)
  }

  subscribe (): Pollable {
    return new Pollable(() => this.#pending === undefined, async () => { await this.#pending })
  }

  [Symbol.dispose] (): void {
    this.#state = 'closed'
    void this.#socket?.close().catch(() => {})
  }
}
