// One error for the http/https methods this queue item deliberately does not
// build, shared by node-http.ts and node-https.ts so both name the same
// reason the same way rather than drifting into two slightly different
// messages for one gap.

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
