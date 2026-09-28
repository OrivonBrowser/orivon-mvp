// wasi:sockets/udp over orivon.net.udpBind. Datagrams that arrive are
// queued for receive(); sends are handed to orivon.net at once, a few in
// flight at a time, so neither call blocks.

import type { Datagram, UdpSocket as OrivonUdpSocket } from '../../contracts/handles.js'
import {
  type IpAddressFamily, type IpSocketAddress, type ResolvedNames, type SocketNet,
  addressOf, formatAddress, reportedAddress, scopeOf, socketErrorCode
} from './addresses.js'
import { Pollable } from './io.js'

interface IncomingDatagram { data: Uint8Array, remoteAddress: IpSocketAddress }
interface OutgoingDatagram { data: Uint8Array, remoteAddress?: IpSocketAddress }

/** How many sends may be in flight before check-send answers zero. */
const SEND_WINDOW = 16

function sameAddress (a: IpSocketAddress, b: IpSocketAddress): boolean {
  return a.val.port === b.val.port && formatAddress(addressOf(a)) === formatAddress(addressOf(b))
}

export class IncomingDatagramStream {
  readonly #queue: IncomingDatagram[] = []
  #wake: Array<() => void> = []
  #error: string | undefined

  constructor (socket: OrivonUdpSocket, family: IpAddressFamily, remote: IpSocketAddress | undefined) {
    void (async () => {
      const reader = socket.readable.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          const from = reportedAddress(value.address, value.port, family)
          if (remote !== undefined && !sameAddress(from, remote)) continue
          this.#queue.push({ data: value.data, remoteAddress: from })
          this.#notify()
        }
      } catch (error) {
        this.#error = socketErrorCode(error)
        this.#notify()
      }
    })()
  }

  #notify (): void {
    const wake = this.#wake
    this.#wake = []
    wake.forEach((resolve) => { resolve() })
  }

  receive (maxResults: bigint): IncomingDatagram[] {
    if (this.#queue.length === 0 && this.#error !== undefined) throw this.#error
    return this.#queue.splice(0, Number(maxResults))
  }

  subscribe (): Pollable {
    return new Pollable(() => this.#queue.length > 0 || this.#error !== undefined, async () => { await new Promise<void>((resolve) => { this.#wake.push(resolve) }) })
  }
}

export class OutgoingDatagramStream {
  readonly #writer: WritableStreamDefaultWriter<Datagram>
  readonly #names: ResolvedNames
  readonly #remote: IpSocketAddress | undefined
  #inFlight = 0
  #error: string | undefined
  #wake: Array<() => void> = []

  constructor (socket: OrivonUdpSocket, names: ResolvedNames, remote: IpSocketAddress | undefined) {
    this.#writer = socket.writable.getWriter()
    this.#names = names
    this.#remote = remote
  }

  checkSend (): bigint {
    if (this.#error !== undefined) throw this.#error
    return BigInt(SEND_WINDOW - this.#inFlight)
  }

  send (datagrams: readonly OutgoingDatagram[]): bigint {
    if (this.#error !== undefined) throw this.#error
    if (datagrams.length > SEND_WINDOW - this.#inFlight) throw new TypeError('a send exceeded what check-send permitted')
    for (const datagram of datagrams) {
      const to = datagram.remoteAddress ?? this.#remote
      if (to === undefined) throw 'invalid-argument'
      if (this.#remote !== undefined && datagram.remoteAddress !== undefined && !sameAddress(to, this.#remote)) throw 'invalid-argument'
      const address = addressOf(to)
      this.#inFlight++
      void this.#writer.write({ data: datagram.data.slice(), address: this.#names.hostFor(address), port: to.val.port, family: address.tag === 'ipv4' ? 'IPv4' : 'IPv6' })
        .catch((error: unknown) => { this.#error = socketErrorCode(error) })
        .finally(() => {
          this.#inFlight--
          const wake = this.#wake
          this.#wake = []
          wake.forEach((resolve) => { resolve() })
        })
    }
    return BigInt(datagrams.length)
  }

  subscribe (): Pollable {
    return new Pollable(() => this.#inFlight < SEND_WINDOW || this.#error !== undefined, async () => { await new Promise<void>((resolve) => { this.#wake.push(resolve) }) })
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
  #failure: string | undefined
  #remote: IpSocketAddress | undefined
  #streamed = false
  #hopLimit = 64
  #buffers = new Map<string, bigint>()

  constructor (net: SocketNet, names: ResolvedNames, family: IpAddressFamily) {
    this.#net = net
    this.#names = names
    this.#family = family
  }

  startBind (_network: unknown, localAddress: IpSocketAddress): void {
    if (this.#state !== 'unbound') throw 'invalid-state'
    if (localAddress.tag !== this.#family) throw 'invalid-argument'
    this.#state = 'bind-started'
    this.#pending = this.#net.udpBind({ port: localAddress.val.port, scope: scopeOf(addressOf(localAddress)) }).then(
      (socket) => { this.#socket = socket },
      (error: unknown) => { this.#failure = socketErrorCode(error) }
    ).finally(() => { this.#pending = undefined })
  }

  finishBind (): void {
    if (this.#state !== 'bind-started') throw 'invalid-state'
    if (this.#pending !== undefined) throw 'would-block'
    if (this.#failure !== undefined) { this.#state = 'closed'; throw this.#failure }
    this.#state = 'bound'
  }

  /** A socket may be streamed once here: a second call would need orivon.net to rebind. */
  stream (remoteAddress: IpSocketAddress | undefined): [IncomingDatagramStream, OutgoingDatagramStream] {
    if (this.#state !== 'bound' || this.#socket === undefined) throw 'invalid-state'
    if (this.#streamed) throw 'not-supported'
    if (remoteAddress !== undefined && remoteAddress.tag !== this.#family) throw 'invalid-argument'
    this.#streamed = true
    this.#remote = remoteAddress
    return [new IncomingDatagramStream(this.#socket, this.#family, remoteAddress), new OutgoingDatagramStream(this.#socket, this.#names, remoteAddress)]
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
