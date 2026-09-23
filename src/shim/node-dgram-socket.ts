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
import { LIMITS } from '../contracts/limits.js'
import { codedError, systemError, toNodeError } from './node-http-errors.js'
import { toBytes, toBytesJoined } from './node-stream-bytes.js'
import { isIP } from './node-net-isip.js'
import { validatePort } from './node-net-args.js'
import { lookup } from './node-dns.js'
import { refuseShim } from './errors.js'
// One of the eight approved core-polyfill packages (module-map.ts) --
// imported directly rather than relying on a global `Buffer`. bencode
// (underneath bittorrent-dht) calls Buffer.isBuffer() on what a 'message'
// handler receives, so handing back a plain Uint8Array would fail that
// check silently.
import { Buffer } from 'buffer'

export type UdpBindFn = (opts: { port: number }) => Promise<UdpSocket>
/** Resolves a send's hostname to an IPv4 literal; dns.lookup unless a test supplies one. */
export type UdpLookupFn = (hostname: string) => Promise<string>

export interface RemoteInfo {
  address: string
  port: number
  family: 'IPv4' | 'IPv6'
  size: number
}

type SendCallback = (error: Error | null) => void

function defaultLookup (hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    lookup(hostname, { family: 4 }, (error, address) => { if (error !== null) reject(error); else resolve(address) })
  })
}

/** Any ArrayBufferView or string, as Node's send() accepts; toBytes itself takes Uint8Array and string only. */
function messageBytes (value: unknown): Uint8Array {
  if (ArrayBuffer.isView(value) && !(value instanceof Uint8Array)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  if (value instanceof Uint8Array || typeof value === 'string') return toBytes(value)
  throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "buffer" argument must be of type string or an instance of Buffer, TypedArray, or DataView.')
}

/** Node's sliceBuffer: offset and length are validated against the message, and the array form refuses them outright. */
function sliceMessage (msg: unknown, offset: unknown, length: unknown): Uint8Array {
  if (Array.isArray(msg)) {
    throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE', 'orivon-node-shim: dgram.send() does not accept offset/length with an array message')
  }
  const bytes = messageBytes(msg)
  const start = Number(offset) >>> 0
  const size = Number(length) >>> 0
  if (start > bytes.length) throw codedError(RangeError, 'ERR_BUFFER_OUT_OF_BOUNDS', '"offset" is outside of buffer bounds')
  if (start + size > bytes.length) throw codedError(RangeError, 'ERR_BUFFER_OUT_OF_BOUNDS', '"length" is outside of buffer bounds')
  return bytes.subarray(start, start + size)
}

/**
 * Node's send() argument rule, positional rather than by type: offset and
 * length are present exactly when an address, or a non-function port,
 * follows them. Port and address are validated here and throw
 * synchronously, as Node's do, so a malformed send never reaches the broker.
 */
function parseSendArgs (args: readonly unknown[]): { bytes: Uint8Array, port: number, address: string, callback: SendCallback | undefined } {
  let [msg, offset, length, port, address, callback] = args
  let bytes: Uint8Array
  if ((address !== undefined && address !== null && address !== '') || (port !== undefined && port !== null && port !== 0 && typeof port !== 'function')) {
    bytes = sliceMessage(msg, offset, length)
  } else {
    callback = port
    port = offset
    address = length
    bytes = Array.isArray(msg) ? toBytesJoined(msg.map(messageBytes)) : messageBytes(msg)
  }
  if (typeof address === 'function') { callback = address; address = undefined }
  const validatedPort = validatePort(port, 'Port', false)
  if (address !== undefined && address !== null && typeof address !== 'string') {
    throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "address" argument must be of type string. Received type ${typeof address}`)
  }
  return {
    bytes,
    port: validatedPort,
    address: typeof address === 'string' && address !== '' ? address : '127.0.0.1',
    callback: typeof callback === 'function' ? callback as SendCallback : undefined
  }
}

function notRunning (): Error & { code: string } {
  return codedError(Error, 'ERR_SOCKET_DGRAM_NOT_RUNNING', 'Not running')
}

export class Socket extends EventEmitter {
  private readonly bindFn: UdpBindFn
  private readonly lookupFn: UdpLookupFn
  private handle: UdpSocket | null = null
  private bindPromise: Promise<UdpSocket> | null = null
  private writer: WritableStreamDefaultWriter<{ data: Uint8Array, address: string, port: number, family: 'IPv4' | 'IPv6' }> | null = null
  private closing = false

  constructor (bindFn: UdpBindFn, lookupFn: UdpLookupFn = defaultLookup) {
    super()
    this.bindFn = bindFn
    this.lookupFn = lookupFn
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
    if (this.closing) throw notRunning()
    const { bytes, port, address, callback } = parseSendArgs(args)
    // Node reports a failed send to its callback, or as 'error' when it has none.
    const report = (error: Error | null): void => {
      if (callback !== undefined) callback(error)
      else if (error !== null && !this.closing) this.emit('error', error)
    }
    const resolved = isIP(address) !== 0 ? Promise.resolve(address) : this.lookupFn(address)
    resolved.then((ip) => {
      if (bytes.length > LIMITS.maxDatagramBytes) { report(systemError('EMSGSIZE', 'send', { address: ip, port })); return }
      const family = isIP(ip) === 6 ? 'IPv6' as const : 'IPv4' as const
      const promise = this.writer !== null ? Promise.resolve(this.writer) : this.writerOnceBound()
      return promise.then((writer) => writer.write({ data: bytes, address: ip, port, family }))
        .then(() => report(null), (error: unknown) => report(toNodeError(error, { syscall: 'send', address: ip, port })))
    }, (error: unknown) => report(toNodeError(error, { syscall: 'getaddrinfo', hostname: address })))
  }

  /** send() before bind() binds implicitly, as Node's does. */
  private async writerOnceBound (): Promise<WritableStreamDefaultWriter<{ data: Uint8Array, address: string, port: number, family: 'IPv4' | 'IPv6' }>> {
    const handle = await (this.bindPromise ?? this.bind().bindPromise)
    if (handle === null) throw notRunning()
    return this.writer ?? handle.writable.getWriter()
  }

  close (callback?: () => void): this {
    // Node emits 'close' exactly once and throws ERR_SOCKET_DGRAM_NOT_RUNNING
    // on a second call. Emitting it twice made a caller that releases
    // resources in its own 'close' handler release them twice -- measured.
    if (this.closing) throw notRunning()
    if (callback !== undefined) this.once('close', callback)
    this.closing = true
    const pending = this.handle !== null
      ? this.handle.close()
      : (this.bindPromise?.then((handle) => handle.close()) ?? Promise.resolve())
    pending.catch(() => {}).then(() => this.emit('close'))
    return this
  }

  // A135: named by presence, not by absence -- real methods (not a
  // module-level refusingProxy wrap) for the same duck-typing reason
  // node-net-socket.ts's own ref/unref/setTimeout methods give: this is a
  // stateful, feature-detected EventEmitter instance, and a throw-on-read
  // proxy would make a defensive `typeof socket.setBroadcast === 'function'`
  // check itself throw.

  /** Real Node's own event-loop keep-alive controls -- no meaning here, so both are no-ops that return `this`, matching real Node's contract and keeping a defensive caller harmless. */
  ref (): this { return this }
  unref (): this { return this }

  private socketOptionUnsupported (api: string): never {
    throw refuseShim(
      `dgram.Socket#${api}`, 'unimplemented',
      `dgram.Socket#${api} is a real UDP socket option orivon.net.udpBind has no capability ` +
      'surface for yet -- nothing has decided whether it will (compatibility-matrix.md Table 3). ' +
      'Present (so a defensive typeof check still finds a function) but throwing when actually ' +
      'called, rather than a silent no-op that would misreport the option as applied.'
    )
  }

  setBroadcast (_flag: boolean): void { this.socketOptionUnsupported('setBroadcast') }
  setMulticastTTL (_ttl: number): void { this.socketOptionUnsupported('setMulticastTTL') }
  setMulticastLoopback (_flag: boolean): void { this.socketOptionUnsupported('setMulticastLoopback') }
  addMembership (_multicastAddress: string, _multicastInterface?: string): void { this.socketOptionUnsupported('addMembership') }
  dropMembership (_multicastAddress: string, _multicastInterface?: string): void { this.socketOptionUnsupported('dropMembership') }
}
