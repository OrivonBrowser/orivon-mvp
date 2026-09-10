// `dns` module target (module-map.ts). NOT BUILT: DNS resolution needs its
// own broker capability (a network permission, like tcp.connect) that does
// not exist yet -- owner decision, out of this lane's scope. The one
// confirmed caller in the target graph is k-rpc-socket's `_resolveAndQuery`,
// which calls `dns.lookup(host, cb)` only for a bootstrap peer named by
// hostname (e.g. 'router.bittorrent.com') rather than an IP literal --
// `net.isIP()` (node-net-isip.ts) is what routes a query there in the first
// place. Failing loudly here, the same way node-http-unsupported.ts and
// node-net-unsupported.ts fail loudly for their own gaps, beats a silent
// hang: `lookup`'s callback fires asynchronously with a named, closed error,
// same as if it could not resolve any name -- never a thrown exception,
// because a lookup failure is exactly what real Node's own async contract
// for this function already looks like.

export class OrivonDnsUnsupportedError extends Error {
  readonly code = 'ERR_ORIVON_DNS_UNSUPPORTED'

  constructor () {
    super(
      'orivon-node-shim: dns.lookup is not supported -- DNS resolution needs its own broker ' +
      'capability, which does not exist yet. Connect to an IP address literal instead of a ' +
      'hostname, or wait for that capability to land.'
    )
    this.name = 'OrivonDnsUnsupportedError'
  }
}

export interface LookupOptions {
  family?: number
  all?: boolean
}

type LookupCallback = (error: Error | null, address: string, family: number) => void

/** lookup(hostname[, options], callback) -- every documented positional form, since real callers pass either. */
export function lookup (_hostname: string, optionsOrCallback: LookupOptions | LookupCallback, callback?: LookupCallback): void {
  const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback
  // Asynchronous on purpose, matching real Node's own contract for this
  // function: a caller that already handles a lookup failure (every
  // confirmed caller does, since real DNS lookups fail in the wild) handles
  // this one identically, with no synchronous throw to also guard against.
  queueMicrotask(() => cb?.(new OrivonDnsUnsupportedError(), '', 0))
}

export default { lookup }
