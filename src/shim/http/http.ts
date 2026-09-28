// `http` module target (module-map.ts). Real Node code does
// `import http from 'http'` and `import { request } from 'http'` both --
// this file supports either via its default export and its named ones.
//
// Wires `orivon.net.connect` (plaintext, port 80 by default) into
// http/client.ts's factory. `https.ts` is the file that differs only
// in which connect method, default port and socket it uses -- see its header.

import { getOrivon } from '../orivon-global.js'
import { createHttpModule } from './client.js'
import { createServer, otherHttpMember } from './unsupported.js'
import { STATUS_CODES, METHODS } from './status-codes.js'
import { Agent, globalAgent } from './agent.js'
import { refusingProxy } from '../unimplemented.js'

export { ClientRequest } from './client.js'
export { IncomingMessage } from './message.js'
export { STATUS_CODES, METHODS, createServer, Agent, globalAgent }

const { request, get } = createHttpModule({
  connect: (opts) => getOrivon().net.connect(opts),
  defaultPort: 80,
  protocol: 'http:'
})

export { request, get }

// A135: anything else read off this default export (Server, validateHeaderName,
// ...) names the gap instead of reading `undefined` -- see http/unsupported.ts.
export default refusingProxy({ request, get, createServer, STATUS_CODES, METHODS, Agent, globalAgent }, otherHttpMember('http'))
