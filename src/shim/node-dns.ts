// `dns` module target (module-map.ts). NOT BUILT: DNS resolution needs its
// own broker capability (a network permission, like tcp.connect) that does
// not exist yet -- owner decision (D-0006), out of this lane's scope. The
// one confirmed caller in the target graph is k-rpc-socket's
// `_resolveAndQuery`, which calls `dns.lookup(host, cb)` only for a bootstrap
// peer named by hostname (e.g. 'router.bittorrent.com') rather than an IP
// literal -- `net.isIP()` (node-net-isip.ts) is what routes a query there in
// the first place. Failing loudly here, the same way node-http-unsupported.ts
// and node-net-unsupported.ts fail loudly for their own gaps, beats a silent
// hang: `lookup`'s callback fires asynchronously with a named, closed error,
// same as if it could not resolve any name -- never a thrown exception,
// because a lookup failure is exactly what real Node's own async contract
// for this function already looks like.
//
// EVERY OTHER dns.* MEMBER (A135): `resolve4`, `resolve6`, `reverse`,
// `setServers`, ... share `lookup`'s own D-0006 gap -- the same missing
// broker capability, not a separate decision -- so the default export (what
// a bundled CJS `require('dns')` resolves to) is wrapped so calling any of
// them names the gap instead of a bare TypeError (A169: reading one is safe,
// same as a real absent member -- only a call still refuses by name).
// `dns.promises` is the one exception, handled at the export below.

import { refusingProxy } from './unimplemented.js'
import { OrivonShimError, refuseShim } from './errors.js'

// A177: extends OrivonShimError so `catch (e) { if (e instanceof
// OrivonShimError) ... }` also catches this one, rather than needing its own
// special case -- name/message/code below are unchanged from before.
export class OrivonDnsUnsupportedError extends OrivonShimError {
  readonly code = 'ERR_ORIVON_DNS_UNSUPPORTED'

  constructor () {
    super(
      'dns.lookup',
      'not-built',
      'dns.lookup is not supported -- DNS resolution needs its own broker capability, which ' +
      'does not exist yet. Connect to an IP address literal instead of a hostname, or wait for ' +
      'that capability to land.'
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

/** dns.lookup's own gap, generalised: every other dns.* member is the same D-0006 capability, unbuilt. */
function otherDnsMember (prop: string) {
  return refuseShim(
    `dns.${prop}`,
    'not-built',
    `dns.${prop} is not supported -- like dns.lookup, it needs the same broker network-resolution ` +
    'capability, which does not exist yet (D-0006, docs/planning/compatibility-matrix.md Table 1). ' +
    'Connect to an IP address literal instead of a hostname, or wait for that capability to land.'
  )
}

export default refusingProxy({
  lookup,
  // dns.promises is an object of promise-returning methods, not a function
  // -- a throwing-function refusal (A169) would misreport its own type, so
  // this is explicitly undefined rather than routed through otherDnsMember.
  promises: undefined
}, otherDnsMember)
