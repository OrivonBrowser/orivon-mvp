// `net` module target (module-map.ts). Wires orivon.net.connect into
// node-net-socket.ts's factory, and exports isIP/isIPv4/isIPv6 -- README.md
// requirement 1's worked example: k-rpc-socket (underneath bittorrent-dht)
// calls net.isIP() before every send, not a socket method, and its absence
// is what silently breaks the DHT with no error at all.

import { getOrivon } from './orivon-global.js'
import { Socket, createConnectFactory } from './node-net-socket.js'
import { createServer } from './node-net-unsupported.js'
import { isIP, isIPv4, isIPv6 } from './node-net-isip.js'

export { Socket } from './node-net-socket.js'
export { createServer } from './node-net-unsupported.js'
export { isIP, isIPv4, isIPv6 } from './node-net-isip.js'

const connect = createConnectFactory((opts) => getOrivon().net.connect(opts))

export { connect }
export const createConnection = connect

export default { connect, createConnection: connect, Socket, createServer, isIP, isIPv4, isIPv6 }
