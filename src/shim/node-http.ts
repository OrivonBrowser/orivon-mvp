// `http` module target (module-map.ts). Real Node code does
// `import http from 'http'` and `import { request } from 'http'` both --
// this file supports either via its default export and its named ones.
//
// Wires `orivon.net.connect` (plaintext, port 80 by default) into
// node-http-client.ts's factory. `https.ts` is the file that differs only
// in which connect method and default port it passes in -- see its header.

import { getOrivon } from './orivon-global.js'
import { createHttpModule } from './node-http-client.js'
import { createServer, otherHttpMember } from './node-http-unsupported.js'
import { STATUS_CODES, METHODS } from './node-http-status-codes.js'
import { refusingProxy } from './unimplemented.js'

export { ClientRequest } from './node-http-client.js'
export { IncomingMessage } from './node-http-message.js'
export { STATUS_CODES, METHODS, createServer }

const { request, get } = createHttpModule({
  connect: (opts) => getOrivon().net.connect(opts),
  defaultPort: 80
})

export { request, get }

// A135: anything else read off this default export (Agent, globalAgent, ...)
// names the gap instead of reading `undefined` -- see node-http-unsupported.ts.
export default refusingProxy({ request, get, createServer, STATUS_CODES, METHODS }, otherHttpMember('http'))
