// `https` module target (module-map.ts). Same client as node-http.ts, wired
// to `orivon.net.connectSecure` and port 443, over node-tls.ts's TLSSocket:
// the broker terminates TLS and hands back a plaintext TcpSocket (ADR-0017).
// TLS options (from the request or its agent's options, which Node merges
// the same way) go through node-tls.ts's checks, so one that would change
// who is trusted refuses by name as the request's 'error' instead of being
// dropped.

import { getOrivon } from './orivon-global.js'
import { createHttpModule, type RequestSocket } from './node-http-client.js'
import { createServer, otherHttpMember } from './node-http-unsupported.js'
import { STATUS_CODES, METHODS } from './node-http-status-codes.js'
import { HttpsAgent as Agent, httpsGlobalAgent as globalAgent } from './node-http-agent.js'
import { connectTls } from './node-tls.js'
import { kDial, type NetDialFn } from './node-net-socket.js'
import type { ResolvedRequestOptions } from './node-http-options.js'
import { refusingProxy } from './unimplemented.js'

export { ClientRequest } from './node-http-client.js'
export { IncomingMessage } from './node-http-message.js'
export { STATUS_CODES, METHODS, createServer, Agent, globalAgent }

/** Node lets an agent's options (`new https.Agent({ rejectUnauthorized: false })`) override the request's own TLS options. */
function tlsSocket (options: ResolvedRequestOptions, dial: NetDialFn): RequestSocket {
  const agentOptions = (options.agent as { options?: Record<string, unknown> } | null | undefined)?.options
  const { path: _path, socketPath: _socketPath, timeout: _timeout, signal: _signal, ...tlsSource } = { ...options.raw, ...agentOptions }
  return connectTls({ ...tlsSource, host: options.host, port: options.port, [kDial]: dial })
}

const { request, get } = createHttpModule({
  connect: (opts) => getOrivon().net.connectSecure(opts),
  defaultPort: 443,
  protocol: 'https:',
  createSocket: tlsSocket
})

export { request, get }

// A135: anything else read off this default export (Server, ...) names the
// gap instead of reading `undefined` -- see node-http-unsupported.ts.
export default refusingProxy({ request, get, createServer, STATUS_CODES, METHODS, Agent, globalAgent }, otherHttpMember('https'))
