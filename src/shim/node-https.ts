// `https` module target (module-map.ts). Same client as node-http.ts, wired
// to `orivon.net.connectSecure` and port 443 instead: the broker terminates
// TLS and hands back a plaintext TcpSocket (ADR-0017), so from this file's
// side a secure request differs from a plain one only in which capability
// method dialled it -- there is no certificate, cipher or TLS-socket API to
// present here, and this module does not pretend to have one. An app that
// reads `res.socket.getPeerCertificate()` or passes `rejectUnauthorized`,
// `ca`/`cert`/`key` gets no such methods/options: the broker's verification
// is unconditional, and no confirmed caller in this repo's target graph asks
// to weaken it, so this file adds no knob that would let one try.

import { getOrivon } from './orivon-global.js'
import { createHttpModule } from './node-http-client.js'
import { createServer } from './node-http-unsupported.js'
import { STATUS_CODES, METHODS } from './node-http-status-codes.js'

export { ClientRequest } from './node-http-client.js'
export { IncomingMessage } from './node-http-message.js'
export { STATUS_CODES, METHODS, createServer }

const { request, get } = createHttpModule({
  connect: (opts) => getOrivon().net.connectSecure(opts),
  defaultPort: 443
})

export { request, get }

export default { request, get, createServer, STATUS_CODES, METHODS }
