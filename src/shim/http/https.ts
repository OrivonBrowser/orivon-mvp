// `https` module target (module-map.ts). Same client as http/http.ts, wired
// to `orivon.net.connectSecure` and port 443, over net/tls.ts's TLSSocket:
// the broker terminates TLS and hands back a plaintext TcpSocket (ADR-0017).
// TLS options come from the request and its agent's options, merged as Node
// merges them, and go to net/tls.ts, which honours them or refuses by name
// as the request's 'error'.

import { getOrivon } from '../orivon-global.js'
import { createHttpModule, type RequestSocket } from './client.js'
import { createServer, otherHttpMember } from './unsupported.js'
import { STATUS_CODES, METHODS } from './status-codes.js'
import { HttpsAgent as Agent, httpsGlobalAgent as globalAgent } from './agent.js'
import { connectTls } from '../net/tls.js'
import { kDial, type NetDialFn } from '../net/socket.js'
import type { ResolvedRequestOptions } from './options.js'
import { refusingProxy } from '../unimplemented.js'
import { isIP } from '../net/isip.js'

export { ClientRequest } from './client.js'
export { IncomingMessage } from './message.js'
export { STATUS_CODES, METHODS, createServer, Agent, globalAgent }

/**
 * Node's https agent sends the Host header's name as SNI when the caller set
 * no servername (`calculateServerName`), and none for an address. Returned
 * only when it differs from the host, whose name the broker sends anyway.
 */
function hostHeaderServername (options: ResolvedRequestOptions): string | undefined {
  const header = options.headers.get('host')
  if (typeof header !== 'string' || header === '') return undefined
  const close = header.indexOf(']')
  const name = header.startsWith('[') ? (close === -1 ? header : header.slice(1, close)) : header.split(':', 1)[0] ?? ''
  const servername = isIP(name) === 0 ? name : ''
  if (servername === '') return isIP(options.host) === 0 ? '' : undefined
  return servername.toLowerCase() === options.host.toLowerCase() ? undefined : servername
}

/** Node lets an agent's options (`new https.Agent({ rejectUnauthorized: false })`) override the request's own TLS options. */
function tlsSocket (options: ResolvedRequestOptions, dial: NetDialFn): RequestSocket {
  const agentOptions = (options.agent as { options?: Record<string, unknown> } | null | undefined)?.options
  const { path: _path, socketPath: _socketPath, timeout: _timeout, signal: _signal, ...tlsSource } = { ...options.raw, ...agentOptions }
  const servername = tlsSource.servername ?? hostHeaderServername(options)
  return connectTls({ ...tlsSource, ...(servername === undefined ? {} : { servername }), host: options.host, port: options.port, [kDial]: dial })
}

const { request, get } = createHttpModule({
  connect: (opts) => getOrivon().net.connectSecure(opts),
  defaultPort: 443,
  protocol: 'https:',
  createSocket: tlsSocket
})

export { request, get }

// A135: anything else read off this default export (Server, ...) names the
// gap instead of reading `undefined` -- see http/unsupported.ts.
export default refusingProxy({ request, get, createServer, STATUS_CODES, METHODS, Agent, globalAgent }, otherHttpMember('https'))
