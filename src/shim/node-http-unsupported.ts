// One error for the http/https methods this queue item deliberately does not
// build, shared by node-http.ts and node-https.ts so both name the same
// reason the same way rather than drifting into two slightly different
// messages for one gap.

import { refuseShim, type OrivonShimError } from './errors.js'

export class OrivonHttpUnsupportedError extends Error {
  readonly code = 'ERR_ORIVON_HTTP_UNSUPPORTED'

  constructor (api: string, reason: string) {
    super(`orivon-node-shim: ${api} is not supported -- ${reason}`)
    this.name = 'OrivonHttpUnsupportedError'
  }
}

/** `http.createServer`/`https.createServer` need `net.listen` wired to a page, which does not exist yet (docs/open-questions.md A114). */
export function createServer (): never {
  throw new OrivonHttpUnsupportedError(
    'createServer',
    'it needs a per-accepted-socket IPC shape that net.listen does not have yet -- see docs/open-questions.md A114. ' +
    'This module builds the HTTP/HTTPS client only.'
  )
}

/**
 * A135: every OTHER http/https member (`Agent`, `globalAgent`, `Server`, ...)
 * used to be silently absent on the default export -- the shape a bundled
 * CJS `require('http'|'https')` resolves to. Shared by node-http.ts and
 * node-https.ts's own `refusingProxy` wrap so both name the gap the same
 * way; `createServer` above already has its own specific, decided reason
 * (A114) and is not reclassified by this.
 */
export function otherHttpMember (moduleName: 'http' | 'https') {
  return (prop: string): OrivonShimError => refuseShim(
    `${moduleName}.${prop}`, 'unimplemented',
    `${moduleName}.${prop} is real Node ${moduleName} surface this shim has not implemented -- ` +
    `this module builds the request()/get() client only (docs/planning/compatibility-matrix.md ` +
    `Table 3). ${moduleName}.createServer refuses with its own decided reason (A114); this does not.`
  )
}
