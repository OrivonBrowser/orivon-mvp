// dgram.Socket over orivon.net.udpBind's UdpSocket (handles.ts). Node's real
// dgram.Socket is an EventEmitter, not a stream -- one packet in, one
// 'message' event out, matching the WHATWG side's own message-oriented
// Datagram shape (one chunk is exactly one UDP packet, never split or
// coalesced).
//
// THE WORKED EXAMPLE FROM shim/README.md REQUIREMENT 1 LIVES ONE LAYER
// DOWN, IN node-net-isip.ts, NOT HERE: k-rpc-socket (bittorrent-dht's
// transport) calls net.isIP() before every send, and getting THIS file
// wrong in a way isIP happens to mask is exactly how that bug hid the first
// time -- see node-net-isip.ts.
//
// DENIAL DOES NOT REJECT A SEND, deliberately matching handle-contracts.md's
// UdpSocket section: `writable.write()` never rejects for a destination
// outside the grant, only `droppedOutbound`/`refusals` would report it, and
// this file does not surface either -- no real Node dgram API has a shape
// for "which past send was silently dropped", so exposing one here would be
// new, Orivon-specific surface no ported caller can use. A send's callback
// therefore fires as soon as the broker has ACCEPTED the write, exactly
// matching UDP's own fire-and-forget delivery contract.

import { EventEmitter } from 'events'
import type { UdpSocket } from '../contracts/handles.js'
import { toNodeError } from './node-http-errors.js'
import { toBytes, toBytesJoined } from './node-stream-bytes.js'
import { isIP } from './node-net-isip.js'
// One of the eight approved core-polyfill packages (module-map.ts) --
// imported directly rather than relying on a global `Buffer`, because
// nothing in this tree installs one yet. bencode (underneath bittorrent-dht)
// calls Buffer.isBuffer() on what a 'message' handler receives, so handing
// back a plain Uint8Array here would fail that check silently.
import { Buffer } from 'buffer'

export type UdpBindFn = (opts: { port: number }) => Promise<UdpSocket>

export interface RemoteInfo {
  address: string
  port: number
  family: 'IPv4' | 'IPv6'
  size: number
}

type SendCallback = (error: Error | null) => void

function parseSendArgs (args: readonly unknown[]): { bytes: Uint8Array, port: number, address: string, callback?: SendCallback } {
  const rest = [...args]
  const callback = typeof rest[rest.length - 1] === 'function' ? rest.pop() as SendCallback : undefined
  const msg = rest.shift()
  const bytes = Array.isArray(msg) ? toBytesJoined(msg) : toBytes(msg)

  let offset: number | undefined
  let length: number | undefined
  if (typeof rest[0] === 'number' && typeof rest[1] === 'number') {
    // Node refuses offset/length paired with the ARRAY message form --
    // ERR_INVALID_ARG_TYPE, because the array is a list of whole buffers and
    // a byte range across their concatenation is not a thing it offers.
    // Refusing here too, rather than silently slicing the join, which is what
    // this did before and would hand the broker a truncated datagram the
    // caller never asked for.
    if (Array.isArray(msg)) {
      throw Object.assign(
        new TypeError('orivon-node-shim: dgram.send() does not accept offset/length with an array message'),
        { code: 'ERR_INVALID_ARG_TYPE' }
      )
    }
    offset = rest.shift() as number
    length = rest.shift() as number
  }
  const port = rest.shift() as number
  const address = (rest.shift() as string | undefined) ?? '127.0.0.1'
  const result: { bytes: Uint8Array, port: number, address: string, callback?: SendCallback } = {
    bytes: offset !== undefined && length !== undefined ? bytes.subarray(offset, offset + length) : bytes,
    port,
    address
  }
  if (callback !== undefined) result.callback = callback
  return result
}

export class Socket extends EventEmitter {
  private readonly bindFn: UdpBindFn
  private handle: UdpSocket | null = null
  private bindPromise: Promise<UdpSocket> | null = null
  private writer: WritableStreamDefaultWriter<{ data: Uint8Array, address: string, port: number, family: 'IPv4' | 'IPv6' }> | null = null
  private closing = false

  constructor (bindFn: UdpBindFn) {
    super()
    this.bindFn = bindFn
  }

  address (): { address: string, port: number, family: string } {
    const handle = this.handle
    if (handle === null) {
      throw Object.assign(new Error('orivon-node-shim: dgram socket is not bound yet'), { code: 'ERR_SOCKET_DGRAM_NOT_RUNNING' })
    }
    return { address: handle.localAddress, port: handle.localPort, family: isIP(handle.localAddress) === 6 ? 'IPv6' : 'IPv4' }
  }

  /** bind([port][, address][, callback]) or bind(options[, callback]) -- every real Node overload k-rpc-socket's `bind.apply` can forward. */
  bind (...args: readonly unknown[]): this {
    // Real Node throws ERR_SOCKET_ALREADY_BOUND here, and the throw is the
    // point: without it the second bind() overwrote `handle`/`writer` and the
    // FIRST UdpSocket was left open with nothing able to reach it -- measured
    // as two handles created, zero closed. That orphan still counts against
    // the simultaneous-socket allowance the app declared in its manifest and
    // the user approved (A80), so the leak is spent against a number a person
    // consented to, and surfaces later as a refusal on a socket the app did
    // ask for.
    if (this.handle !== null || this.bindPromise !== null) {
      throw Object.assign(
        new Error('orivon-node-shim: dgram socket is already bound'),
        { code: 'ERR_SOCKET_ALREADY_BOUND' }
      )
    }
    const rest = [...args]
    const callback = typeof rest[rest.length - 1] === 'function' ? rest.pop() as () => void : undefined
    const first = rest[0]
    const port = typeof first === 'object' && first !== null ? (first as { port?: number }).port ?? 0 : (typeof first === 'number' ? first : 0)
    if (callback !== undefined) this.once('listening', callback)

    // Async-IIFE-wrapped for the same reason node-net-socket.ts's connect()
    // is: `this.bindFn` can throw synchronously (getOrivon() does), and
    // every other failure here surfaces through 'error', never a throw.
    const promise = (async () => this.bindFn({ port }))()
    this.bindPromise = promise
    promise.then((handle) => {
      if (this.closing) { handle.close().catch(() => {}); return }
      this.handle = handle
      this.writer = handle.writable.getWriter()
      this._pumpMessages(handle)
      this.emit('listening')
    }).catch((error) => {
      // A FAILED bind leaves the socket UNBOUND, so it has to stay
      // re-bindable -- real Node resets its own bind state on failure for
      // exactly that reason, and the retry-on-another-port-after-EADDRINUSE
      // pattern depends on it. Without this reset the guard above bricks the
      // Socket permanently on the commonest path there is: udpBind denied
      // because the origin holds no grant yet, the user then approves one,
      // and the app's retry throws ERR_SOCKET_ALREADY_BOUND forever.
      // Compared against `promise` rather than cleared outright so a stale
      // rejection cannot wipe out a newer bind's own in-flight promise.
      if (this.bindPromise === promise) this.bindPromise = null
      this.emit('error', toNodeError(error))
    })
    return this
  }

  private _pumpMessages (handle: UdpSocket): void {
    const reader = handle.readable.getReader()
    void (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) return
          const rinfo: RemoteInfo = { address: value.address, port: value.port, family: value.family, size: value.data.length }
          this.emit('message', Buffer.from(value.data), rinfo)
        }
      } catch (error) {
        if (!this.closing) this.emit('error', toNodeError(error))
      }
    })()
  }

  send (...args: readonly unknown[]): void {
    const { bytes, port, address, callback } = parseSendArgs(args)
    const family = isIP(address) === 6 ? 'IPv6' as const : 'IPv4' as const
    const deliver = (writer: WritableStreamDefaultWriter<{ data: Uint8Array, address: string, port: number, family: 'IPv4' | 'IPv6' }>): void => {
      writer.write({ data: bytes, address, port, family })
        .then(() => callback?.(null))
        .catch((error) => callback?.(toNodeError(error)))
    }
    if (this.writer !== null) { deliver(this.writer); return }
    const promise = this.bindPromise ?? this.bind().bindPromise
    promise?.then((handle) => deliver(this.writer ?? handle.writable.getWriter()))
      .catch((error) => callback?.(toNodeError(error)))
  }

  close (callback?: () => void): this {
    // Node emits 'close' exactly once and throws ERR_SOCKET_DGRAM_NOT_RUNNING
    // on a second call. Emitting it twice made a caller that releases
    // resources in its own 'close' handler release them twice -- measured.
    if (this.closing) {
      throw Object.assign(
        new Error('orivon-node-shim: dgram socket is not running'),
        { code: 'ERR_SOCKET_DGRAM_NOT_RUNNING' }
      )
    }
    if (callback !== undefined) this.once('close', callback)
    this.closing = true
    const pending = this.handle !== null
      ? this.handle.close()
      : (this.bindPromise?.then((handle) => handle.close()) ?? Promise.resolve())
    pending.catch(() => {}).then(() => this.emit('close'))
    return this
  }
}
