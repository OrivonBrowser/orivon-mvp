// `net` module target (module-map.ts). Wires orivon.net.connect into
// net/socket.ts's factory and orivon.net.listen into
// net/server.ts's, and exports isIP/isIPv4/isIPv6 -- README.md
// requirement 1's worked example: k-rpc-socket (underneath bittorrent-dht)
// calls net.isIP() before every send, not a socket method, and its absence
// is what silently breaks the DHT with no error at all.

import { getOrivon } from '../orivon-global.js'
import { Socket, createConnectFactory } from './socket.js'
import { Server, createServerFactory } from './server.js'
import { isIP, isIPv4, isIPv6 } from './isip.js'
import { refusingProxy } from '../unimplemented.js'
import { refuseShim } from '../errors.js'

export { Socket } from './socket.js'
export { Server } from './server.js'
export { isIP, isIPv4, isIPv6 } from './isip.js'

const connect = createConnectFactory((opts) => getOrivon().net.connect(opts))
const createServer = createServerFactory((opts) => getOrivon().net.listen(opts))

export { connect, createServer }
export const createConnection = connect

/** A135: every OTHER net member -- `getDefaultAutoSelectFamily`, ... -- is real Node net surface this shim has not implemented and has not decided whether it will (compatibility-matrix.md Table 3). `connect`/`createServer`/`Socket`/`Server` above are the decided, built surface; this is everything else. */
function otherNetMember (prop: string) {
  return refuseShim(
    `net.${prop}`, 'unimplemented',
    `net.${prop} is real Node net surface this shim has not implemented and has not decided ` +
    'whether it will. See docs/planning/compatibility-matrix.md Table 3.'
  )
}

// A135: anything else read off this default export (a bundled CJS
// `require('net')`'s own shape) names the gap instead of reading `undefined`.
export default refusingProxy(
  { connect, createConnection: connect, Socket, createServer, Server, isIP, isIPv4, isIPv6 },
  otherNetMember
)
