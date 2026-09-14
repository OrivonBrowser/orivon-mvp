// net.createServer, deliberately not built -- same shape as
// node-http-unsupported.ts's createServer, and the same underlying gap: A114.

import { refuseShim, type OrivonShimError } from './errors.js'

export class OrivonNetUnsupportedError extends Error {
  readonly code = 'ERR_ORIVON_NET_UNSUPPORTED'

  constructor (api: string, reason: string) {
    super(`orivon-node-shim: ${api} is not supported -- ${reason}`)
    this.name = 'OrivonNetUnsupportedError'
  }
}

/** `net.createServer` needs a per-accepted-socket delivery shape `orivon.net.listen` does not have yet -- docs/open-questions.md A114. */
export function createServer (): never {
  throw new OrivonNetUnsupportedError(
    'net.createServer',
    'TcpServer.connections has no way to hand a page a fresh port per accepted socket yet -- ' +
    'see docs/open-questions.md A114. This module builds the TCP client only.'
  )
}

/**
 * A135: every OTHER net member read off the default export (a bundled CJS
 * `require('net')`'s own shape) used to be silently absent. `net.Server` --
 * the class real code sometimes reaches for directly, alongside the
 * `createServer` factory above -- shares createServer's own decided A114
 * gap; everything else defaults to 'unimplemented' (nothing decided).
 */
export function otherNetMember (prop: string): OrivonShimError {
  if (prop === 'Server') {
    return refuseShim(
      'net.Server', 'not-built',
      'net.Server needs the same per-accepted-socket delivery shape net.createServer does -- ' +
      'see docs/open-questions.md A114. This module builds the TCP client only.'
    )
  }
  return refuseShim(
    `net.${prop}`, 'unimplemented',
    `net.${prop} is real Node net surface this shim has not implemented and has not decided ` +
    'whether it will. See docs/planning/compatibility-matrix.md Table 3.'
  )
}
