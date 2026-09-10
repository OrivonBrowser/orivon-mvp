// `dgram` module target (module-map.ts). Wires orivon.net.udpBind into
// node-dgram-socket.ts -- the transport bittorrent-dht actually binds to.

import { getOrivon } from './orivon-global.js'
import { Socket } from './node-dgram-socket.js'

export { Socket } from './node-dgram-socket.js'

/** createSocket('udp4' | 'udp6' | {type, ...}[, messageListener]) -- the type/options are accepted for API-shape compatibility; orivon.net.udpBind has no dual-stack or socket-option surface to route them to. */
export function createSocket (typeOrOptions: unknown, messageListener?: (msg: Buffer, rinfo: unknown) => void): Socket {
  const socket = new Socket((opts) => getOrivon().net.udpBind(opts))
  if (messageListener !== undefined) socket.on('message', messageListener)
  void typeOrOptions // accepted, unused -- see this function's own doc comment.
  return socket
}

export default { createSocket }
