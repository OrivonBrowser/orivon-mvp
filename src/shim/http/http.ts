// `http` module target (module-map.ts). Real Node code does
// `import http from 'http'` and `import { request } from 'http'` both --
// this file supports either via its default export and its named ones.
//
// Wires `orivon.net.connect` (plaintext, port 80 by default) into
// http/client.ts's factory, and exports the server half (http/server.ts) over
// `orivon.net.listen`. `https.ts` is the file that differs only in which connect
// method, default port and socket it uses -- see its header. It has no server.

import { getOrivon } from '../orivon-global.js'
import { ClientRequest, createHttpModule } from './client.js'
import { IncomingMessage } from './message.js'
import { otherHttpMember } from './unsupported.js'
import { Server, createServer } from './server.js'
import { ServerResponse } from './server-response.js'
import { OutgoingMessage } from './outgoing-message.js'
import { validateHeaderName, validateHeaderValue } from './header-validation.js'
import { MAX_HEADER_SIZE as maxHeaderSize } from './request-parser.js'
import { STATUS_CODES, METHODS } from './status-codes.js'
import { Agent, globalAgent } from './agent.js'
import { refusingProxy } from '../unimplemented.js'

export { ClientRequest, IncomingMessage }
export { STATUS_CODES, METHODS, createServer, Server, ServerResponse, OutgoingMessage, validateHeaderName, validateHeaderValue, maxHeaderSize, Agent, globalAgent }

const { request, get } = createHttpModule({
  connect: (opts) => getOrivon().net.connect(opts),
  defaultPort: 80,
  protocol: 'http:'
})

export { request, get }

// A287: the named-export gaps a bundled CommonJS require()'s namespace needs.
export * from './generated/http.js'

// A135: anything else read off this default export (Server, validateHeaderName,
// ...) names the gap instead of reading `undefined` -- see http/unsupported.ts.
export default refusingProxy({
  request, get, createServer, Server, ServerResponse, OutgoingMessage, IncomingMessage, ClientRequest,
  validateHeaderName, validateHeaderValue, maxHeaderSize, STATUS_CODES, METHODS, Agent, globalAgent
}, otherHttpMember('http'))
