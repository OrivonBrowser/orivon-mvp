// net.createServer, deliberately not built -- same shape as
// node-http-unsupported.ts's createServer, and the same underlying gap: A114.

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
