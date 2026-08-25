// GATE 1b -- the `dgram` shim. What `import dgram from 'dgram'` resolves to
// inside the renderer bundle.
//
// An EventEmitter, NOT a stream. dgram.Socket is message-oriented, and k-rpc
// (the DHT's RPC layer) depends on that shape precisely.
//
// Surface required, read out of k-rpc-socket/index.js rather than guessed:
//   :26  dgram.createSocket('udp4')
//   :27  socket.on('message', (msg, rinfo) => ...)
//   :28  socket.on('error', ...)
//   :29  socket.on('listening', ...)
//   :131 socket.address()                              <-- SYNCHRONOUS
//   :144 socket.send(buf, 0, buf.length, port, address, cb)
//   :157 socket.close()
//
// THE INTERESTING CONSTRAINT: address() is synchronous, but binding crosses an
// async IPC boundary. The real port is therefore cached when the main process
// reports 'listening', and address() reads the cache. k-rpc only calls it
// after listening, so this is sound -- but it is exactly the kind of
// synchronous-shape-over-async-transport problem capability-api.md design
// rule 2 exists for, and the A10 handle contract must address it generally.
import { EventEmitter } from 'events'

const bridge = globalThis.__spikeDgram

export class Socket extends EventEmitter {
  constructor (type = 'udp4') {
    super()
    this.type = type
    this._address = null
    this._closed = false

    this._handle = bridge.create(type, {
      onListening: (addr) => {
        this._address = addr
        this.emit('listening')
      },
      onMessage: (bytes, rinfo) => { this.emit('message', bytes, rinfo) },
      onError: (message) => { this.emit('error', new Error(message)) },
      onClose: () => {
        if (!this._closed) { this._closed = true; this.emit('close') }
      }
    })
  }

  bind (port, address, callback) {
    if (typeof port === 'function') { callback = port; port = 0; address = undefined }
    if (typeof address === 'function') { callback = address; address = undefined }
    if (typeof callback === 'function') this.once('listening', callback)
    this._handle.bind(port ?? 0, address ?? null)
    return this
  }

  /**
   * Node's signature is send(msg, offset, length, port, address, cb). k-rpc
   * always uses the full six-argument form; the shorter forms are accepted
   * for completeness.
   */
  send (msg, offset, length, port, address, callback) {
    if (typeof offset !== 'number') {
      // send(msg, port, address, cb)
      callback = port
      address = length
      port = offset
      offset = 0
      length = msg.length
    }
    const bytes = msg instanceof Uint8Array ? msg : new Uint8Array(msg)
    const slice = (offset === 0 && length === bytes.length)
      ? bytes
      : bytes.subarray(offset, offset + length)

    this._handle.send(slice, port, address)
    if (typeof callback === 'function') queueMicrotask(() => callback(null))
    return this
  }

  /** SYNCHRONOUS by contract. Returns the cached bind result. */
  address () {
    if (this._address === null) {
      throw new Error('dgram shim: address() called before the socket was bound')
    }
    return this._address
  }

  close (callback) {
    if (typeof callback === 'function') this.once('close', callback)
    this._handle.close()
    return this
  }

  setTTL () { return this }
  setBroadcast () { return this }
  setMulticastTTL () { return this }
  addMembership () { return this }
  dropMembership () { return this }
  ref () { return this }
  unref () { return this }
}

export function createSocket (options, listener) {
  const type = typeof options === 'string' ? options : (options?.type ?? 'udp4')
  const socket = new Socket(type)
  if (typeof listener === 'function') socket.on('message', listener)
  return socket
}

export default { createSocket, Socket }
