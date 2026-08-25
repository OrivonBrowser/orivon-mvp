// GATE 1a -- the `net` shim. This is what `import net from 'net'` resolves to
// inside the renderer bundle, beating webtorrent's `browser` field.
//
// streamx, not readable-stream: webtorrent and bittorrent-protocol are both
// built on streamx (peer.js uses streamx `pipeline`, and a wire IS a streamx
// Duplex), so matching it keeps a second stream implementation out of the
// bundle and makes pipeline() work without adapters.
//
// Surface required by webtorrent, read out of the installed source rather
// than guessed:
//   torrent.js:2104  typeof net.connect === 'function'   <-- the WebRTC-only gate
//   torrent.js:2125  net.connect({host, port})
//   peer.js          conn.once('connect'|'error'|'close'|'end'|'finish')
//                    conn.remoteAddress, conn.remotePort, conn.destroy()
//                    streamx pipeline(conn, wire, conn)
import { Duplex } from 'streamx'

// k-rpc-socket (webtorrent's DHT client) calls net.isIP(peer.host) to decide
// whether to send a UDP datagram straight to the address or fall back to a
// DNS resolve first. The real Node `net` module exports isIP/isIPv4/isIPv6;
// this shim did not, so the call threw a TypeError that k-rpc-socket
// swallowed silently -- no datagram was ever sent, and nothing in the log
// said why.
//   k-rpc-socket/index.js:3  const isIP = require('net').isIP
//
// IPv4: four dot-separated decimal octets 0-255, no leading zeros other than
// a bare "0". IPv6: the common textual forms, including "::" compression and
// IPv4-mapped addresses like "::ffff:127.0.0.1". Pragmatic, not exhaustive --
// this is spike-only code standing in for Node's real isIP.
const IPV4_RE =
  /^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/

const IPV4_TAIL = '(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}'

const IPV6_RE = new RegExp('^(' + [
  '([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}',
  '([0-9a-fA-F]{1,4}:){1,7}:',
  '([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}',
  '([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}',
  '([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}',
  '([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}',
  '([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}',
  '[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})',
  ':((:[0-9a-fA-F]{1,4}){1,7}|:)',
  'fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]+',
  '::(ffff(:0{1,4})?:)?' + IPV4_TAIL,
  '([0-9a-fA-F]{1,4}:){1,4}:' + IPV4_TAIL
].join('|') + ')$')

export function isIPv4 (input) {
  return typeof input === 'string' && IPV4_RE.test(input)
}

export function isIPv6 (input) {
  return typeof input === 'string' && IPV6_RE.test(input)
}

export function isIP (input) {
  if (isIPv4(input)) return 4
  if (isIPv6(input)) return 6
  return 0
}

const bridge = globalThis.__spikeNet

export class Socket extends Duplex {
  constructor (host, port) {
    super()
    this.remoteAddress = host
    this.remotePort = port
    this.connecting = true
    this._ended = false

    this._handle = bridge.connect(host, port, {
      onConnect: () => {
        this.connecting = false
        this.emit('connect')
      },
      onData: (bytes) => { this.push(bytes) },
      onEnd: () => {
        if (!this._ended) { this._ended = true; this.push(null) }
      },
      onClose: () => {
        if (!this._ended) { this._ended = true; this.push(null) }
      },
      onError: (message) => { this.destroy(new Error(message)) }
    })
  }

  _write (data, cb) {
    this._handle.write(data instanceof Uint8Array ? data : new Uint8Array(data))
    cb(null)
  }

  _final (cb) {
    this._handle.end()
    cb(null)
  }

  _destroy (cb) {
    this._handle.destroy()
    cb(null)
  }

  // Called by webtorrent/bittorrent-protocol. Must exist and be harmless --
  // the real socket options live on the main-process side.
  setNoDelay () { return this }
  setKeepAlive () { return this }
  setTimeout () { return this }
  ref () { return this }
  unref () { return this }
}

export function connect (options, listener) {
  const socket = new Socket(options.host, options.port)
  if (typeof listener === 'function') socket.once('connect', listener)
  return socket
}

export const createConnection = connect

// webtorrent only needs `connect` for the outgoing path. `createServer` is the
// INCOMING path (lib/conn-pool.js), which gate 1a does not exercise -- seeding
// is a separate question, recorded as debt in the spike plan.
export function createServer () {
  throw new Error('net.createServer is not shimmed in gate 1a (incoming/seeding path)')
}

export default { connect, createConnection, createServer, Socket, isIP, isIPv4, isIPv6 }
