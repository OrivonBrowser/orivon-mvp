// `dgram` module target (module-map.ts). Wires orivon.net.udpBind into
// net/dgram-socket.ts -- the transport bittorrent-dht actually binds to.

import { getOrivon } from '../orivon-global.js'
import { nodeModule } from '../polyfills/module-proxy.js'
import { Socket } from './dgram-socket.js'

export { Socket } from './dgram-socket.js'

/** createSocket('udp4' | 'udp6' | {type, ...}[, messageListener]) -- the type/options are accepted for API-shape compatibility; orivon.net.udpBind has no dual-stack or socket-option surface to route them to. */
export function createSocket (typeOrOptions: unknown, messageListener?: (msg: Buffer, rinfo: unknown) => void): Socket {
  const socket = new Socket((opts) => getOrivon().net.udpBind(opts))
  if (messageListener !== undefined) socket.on('message', messageListener)
  void typeOrOptions // accepted, unused -- see this function's own doc comment.
  return socket
}

// A287: the named-export gaps a bundled CommonJS require()'s namespace needs.
export * from './generated/dgram.js'

export default nodeModule('dgram', { createSocket, Socket })
