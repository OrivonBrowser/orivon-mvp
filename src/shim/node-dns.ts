// `dns` module target (module-map.ts), over orivon.net.lookup (d-0030),
// merged since this file's earlier NOT-BUILT header was written. The one
// confirmed caller in the target graph is k-rpc-socket's `_resolveAndQuery`,
// which calls `dns.lookup(host, cb)` -- hostname and callback only, no
// options -- only for a bootstrap peer named by hostname (e.g.
// 'router.bittorrent.com') rather than an IP literal; `net.isIP()`
// (node-net-isip.ts) is what routes a query there in the first place.
//
// A152's LESSON: a real denial must surface as `err.code === 'denied'`, not
// a generic 'internal' one a ported app cannot branch on -- toNodeError
// (node-http-errors.ts, already reused by every other capability here)
// already gives 'denied' exactly that treatment, so this file does not
// reinvent it.
//
// d-0031/A193: a lookup denied because only https.connect is held now
// NAMES that reason too, without the broker's own 'denied' reply saying
// anything new -- see describeLookupDenial below for how and why.
//
// NO SECOND ROUND TRIP: orivon.net.lookup returns every resolved address
// in resolver order (capability-api.ts's own doc on this). `{ all: true }`
// is that array, filtered by `family` when asked; the default single-result
// shape is its first entry.

import { getOrivon } from './orivon-global.js'
import { systemError, toNodeError } from './node-http-errors.js'
import { isIP } from './node-net-isip.js'
import { refusingProxy } from './unimplemented.js'
import { refuseShim } from './errors.js'
import type { LookupAddress } from '../contracts/handles.js'

/** `hints`, `verbatim` and `order` are accepted and ignored: the broker's resolver order is what comes back. */
export interface LookupOptions {
  family?: number | 'IPv4' | 'IPv6'
  all?: boolean
  hints?: number
  verbatim?: boolean
  order?: string
}

export interface LookupResult { address: string, family: number }

type LookupCallback = (error: Error | null, address: string, family: number) => void
type LookupAllCallback = (error: Error | null, addresses: LookupResult[]) => void

function toNodeFamily (family: LookupAddress['family']): number { return family === 'IPv6' ? 6 : 4 }

function notFoundError (hostname: string): Error & { code: string } {
  return systemError('ENOTFOUND', 'getaddrinfo', { hostname })
}

/** Node's family option: 4, 6, 0, or the 'IPv4'/'IPv6' strings it accepts for backward compatibility. */
function familyNumber (family: LookupOptions['family']): 0 | 4 | 6 {
  if (family === 4 || family === 'IPv4') return 4
  if (family === 6 || family === 'IPv6') return 6
  return 0
}

/** `lookup(host, 6, cb)` and `lookup(host, { family: 6 }, cb)` are the same call in Node. */
function normaliseOptions (options: unknown): LookupOptions {
  if (typeof options === 'number') return { family: options }
  if (typeof options === 'object' && options !== null) return options as LookupOptions
  return {}
}

/** True for a value shaped enough like a 'denied' rejection to be worth enriching below -- the real, closed-enum validation still happens downstream in toNodeError's own isOrivonError, which this does not attempt to duplicate. */
function looksDenied (error: unknown): error is { name?: unknown, code: 'denied' } {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'denied'
}

/**
 * Names a `net.lookup` 'denied' for a ported app's benefit, WITHOUT the
 * broker's own reply saying anything new. `checkLookup` (../broker/policy/
 * lookup.ts) answers the same uniform, detail-free 'denied' regardless of
 * WHY -- no held network grant at all, a held grant whose pattern does not
 * name this host, or (d-0031, docs/open-questions.md A190/A193) a held
 * `https.connect` that was never eligible in the first place, because
 * `checkConnectSecure` verifies by certificate and never resolves a name.
 * Telling the last of those apart from the other two needs information the
 * broker's reply is not allowed to carry -- so this reads
 * `orivon.app.grants()` instead, which the app already has a standing,
 * legitimate right to query about ITSELF (capability-api.ts's own
 * `OrivonApp.grants`), rather than inventing a new channel from the broker.
 *
 * BEST-EFFORT ONLY. A `grants()` failure, or a held-grant set that does not
 * match the https-connect-only shape, falls back to the ordinary generic
 * message -- this must never replace or hide the real denial with a guess
 * that turns out wrong, only add to it when the answer is certain.
 */
async function describeLookupDenial (hostname: string): Promise<string> {
  try {
    const held = await getOrivon().app.grants()
    const hasRawConnect = held.some((grant) => grant.capability === 'tcp.connect' || grant.capability === 'udp.send')
    const hasHttpsOnly = !hasRawConnect && held.some((grant) => grant.capability === 'https.connect')
    if (hasHttpsOnly) {
      return `orivon-node-shim: getaddrinfo denied ${hostname} -- https.connect does not authorise DNS ` +
        'lookup (it verifies by certificate, never by resolved address); hold tcp.connect or udp.send ' +
        'to resolve a hostname (docs/open-questions.md A193)'
    }
  } catch {
    // Best-effort context only, per this function's own header -- a
    // grants() failure must not replace or hide the real lookup denial.
  }
  return `orivon-node-shim: getaddrinfo denied ${hostname}`
}

/** orivon.net.lookup's own resolved order, narrowed to `options.family` when given -- no second round trip either way (this file's own header). */
async function resolveAddresses (hostname: string, options: LookupOptions): Promise<readonly LookupAddress[]> {
  let addresses: readonly LookupAddress[]
  try {
    addresses = await getOrivon().net.lookup({ hostname })
  } catch (error) {
    if (looksDenied(error)) {
      // Read, never spread: a real `Error` instance keeps `message` (and,
      // absent an explicit override, `name`) as OWN but NON-ENUMERABLE
      // properties, so `{ ...error }` silently drops them -- a plain
      // property read does not, regardless of enumerability or where in
      // the prototype chain the value sits.
      const name = typeof error.name === 'string' ? error.name : 'OrivonError'
      throw { name, code: 'denied', message: await describeLookupDenial(hostname) }
    }
    throw error
  }
  const family = familyNumber(options.family)
  if (family === 0) return addresses
  const wanted: LookupAddress['family'] = family === 6 ? 'IPv6' : 'IPv4'
  return addresses.filter((address) => address.family === wanted)
}

/**
 * Every address a lookup yields, in resolver order. An IP literal is its
 * own answer and 'localhost' is loopback, both without a capability call,
 * as Node's lookup never asks a resolver about a literal either.
 */
async function lookupAll (hostname: string, options: LookupOptions): Promise<LookupResult[]> {
  const literal = isIP(hostname)
  if (literal !== 0) return [{ address: hostname, family: literal }]
  if (hostname.toLowerCase() === 'localhost') {
    return familyNumber(options.family) === 6 ? [{ address: '::1', family: 6 }] : [{ address: '127.0.0.1', family: 4 }]
  }
  let addresses: readonly LookupAddress[]
  try {
    addresses = await resolveAddresses(hostname, options)
  } catch (error) {
    throw toNodeError(error, { syscall: 'getaddrinfo', hostname })
  }
  if (addresses.length === 0) throw notFoundError(hostname)
  return addresses.map((address) => ({ address: address.address, family: toNodeFamily(address.family) }))
}

/** dns.lookup(hostname[, options], callback) -- `options` an object or a bare family number, as in Node. */
export function lookup (hostname: string, callback: LookupCallback): void
export function lookup (hostname: string, options: number | (LookupOptions & { all?: false }), callback: LookupCallback): void
export function lookup (hostname: string, options: LookupOptions & { all: true }, callback: LookupAllCallback): void
export function lookup (
  hostname: string,
  optionsOrCallback: number | LookupOptions | LookupCallback | LookupAllCallback,
  callback?: LookupCallback | LookupAllCallback
): void {
  const options = normaliseOptions(optionsOrCallback)
  const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback
  if (cb === undefined) return
  lookupAll(hostname, options).then((results) => {
    if (options.all === true) { (cb as LookupAllCallback)(null, results); return }
    const picked = results[0] as LookupResult
    ;(cb as LookupCallback)(null, picked.address, picked.family)
  }, (error: unknown) => {
    if (options.all === true) (cb as LookupAllCallback)(error as Error, []); else (cb as LookupCallback)(error as Error, '', 0)
  })
}

/** dns.promises.lookup(hostname[, options]) -- `options` may also be a bare family number, matching real Node's own overload. */
export async function lookupPromise (hostname: string, options: LookupOptions | number = {}): Promise<LookupResult | LookupResult[]> {
  const opts = normaliseOptions(options)
  const results = await lookupAll(hostname, opts)
  return opts.all === true ? results : results[0] as LookupResult
}

function otherDnsPromisesMember (prop: string) {
  return refuseShim(
    `dns.promises.${prop}`, 'unimplemented',
    `dns.promises.${prop} is real Node dns surface this shim has not implemented and has not ` +
    'decided whether it will -- distinct from dns.promises.lookup, which is built. See ' +
    'docs/planning/compatibility-matrix.md Table 3.'
  )
}

export const promises = refusingProxy({ lookup: lookupPromise }, otherDnsPromisesMember)

/** Every other dns.* member -- `resolve4`, `resolve6`, `reverse`, `setServers`, ... -- is real Node dns surface this shim has not implemented and has not decided whether it will (compatibility-matrix.md Table 3), distinct from `lookup`/`promises.lookup` above, which are built. */
function otherDnsMember (prop: string) {
  return refuseShim(
    `dns.${prop}`, 'unimplemented',
    `dns.${prop} is real Node dns surface this shim has not implemented and has not decided ` +
    'whether it will. See docs/planning/compatibility-matrix.md Table 3.'
  )
}

export default refusingProxy({ lookup, promises }, otherDnsMember)
