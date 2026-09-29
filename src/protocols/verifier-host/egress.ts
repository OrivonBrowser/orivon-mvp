// Every request the verifier host makes leaves through one of these. A fixed
// endpoint list gets `allowlisted`; a URL chosen by a name's resolver
// contract gets `guardedCcipRequest`. Anything else throws.

import type { Hex } from 'viem'
import { classifyAddress, isPublicUnicast } from '../../broker/policy/address.js'
import { redirectRefusal } from '../../loader/electron/fetch.js'
import { readCapped } from '../ipfs/gateways.js'
import type { CcipRequestParameters } from '../ens/resolver.js'
import { BUILTIN_ADDRESSES } from '../builtin.js'
import type { DirectFetch } from './direct-fetch.js'

export type WebFetch = (url: string, init?: RequestInit) => Promise<Response>

export class EgressRefused extends Error {
  override readonly name = 'EgressRefused'
}

/**
 * A fetch that reaches only `origins`, and follows no redirect: a
 * configured endpoint that redirects elsewhere would otherwise take the
 * request with it.
 */
export function allowlisted (origins: readonly string[], fetch: WebFetch, label: string): WebFetch {
  const allowed = new Set(origins.map((o) => new URL(o).origin))
  return async (url, init) => {
    const origin = new URL(url).origin
    if (!allowed.has(origin)) throw new EgressRefused(`${label} may not reach ${origin}`)
    return await fetch(url, { ...init, redirect: 'error' })
  }
}

export interface CcipDeps {
  /** Every address the host resolves to, from the same resolver the request will use. */
  readonly resolveHost: (host: string) => Promise<readonly string[]>
  /**
   * Dials the address this module already checked, TLS still verified
   * against the real hostname -- never a second, unpinned resolution, which
   * a rebinding resolver could answer with a private address after
   * `resolveHost` above saw only public ones (`direct-fetch.ts`). Configured
   * with `allowPost` (CCIP-Read's non-`{data}` form) and `allowRedirect`
   * (this module follows a redirect itself, per hop, rather than direct-fetch's
   * ordinary gateway rule of refusing one outright). Used only when `direct`
   * is true: a configured proxy must keep doing the resolving (T20), so
   * pinning an address would silently go around it.
   */
  readonly directFetch: DirectFetch
  /** The ordinary path, over Electron's `net`, resolving `url`'s hostname a
   * second time at connect time -- exactly the rebind window `directFetch`
   * above exists to close, accepted here only because a proxy is the one
   * thing that must not be gone around to close it. Used only when `direct`
   * is false. */
  readonly fetch: WebFetch
  /** Whether no proxy applies to this session, checked once when the host
   * started (`main/verifier/verifier-subsystem.ts`'s `ccipDirectFor`): a
   * snapshot, not re-checked per request or per URL. */
  readonly direct: boolean
}

export interface CcipLimits {
  readonly maxResponseBytes: number
  readonly timeoutMs: number
}

export const DEFAULT_CCIP_LIMITS: CcipLimits = { maxResponseBytes: 1024 * 1024, timeoutMs: 10_000 }

const MAX_URLS = 8
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/

type UrlCheck = { readonly ok: true, readonly addresses: readonly string[] } | { readonly ok: false, readonly refusal: string }

/** Whether a URL may be requested at all, and if so, the address(es) it must be dialled at -- resolved here, and nowhere else, so nothing later re-resolves the name at connect time. */
async function checkUrl (raw: string, deps: CcipDeps): Promise<UrlCheck> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, refusal: `not a URL: ${raw}` }
  }
  if (url.protocol !== 'https:') return { ok: false, refusal: `only https is allowed, not ${url.protocol}` }
  if (url.username !== '' || url.password !== '') return { ok: false, refusal: 'credentials in the URL' }
  if (url.port !== '' && url.port !== '443') return { ok: false, refusal: `only port 443 is allowed, not ${url.port}` }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (classifyAddress(host) !== 'unparseable') {
    return isPublicUnicast(host) ? { ok: true, addresses: [host] } : { ok: false, refusal: `${host} is not a public address` }
  }
  // A protocol host resolves to the verifier itself, never to a public server.
  if (host === 'localhost' || host.endsWith('.localhost') || BUILTIN_ADDRESSES.routesToVerifier(host)) return { ok: false, refusal: `${host} is not a public name` }
  const addresses = await deps.resolveHost(host)
  if (addresses.length === 0) return { ok: false, refusal: `${host} resolved to no address` }
  const private_ = addresses.find((a) => !isPublicUnicast(a))
  if (private_ !== undefined) return { ok: false, refusal: `${host} resolves to ${private_}, which is not a public address` }
  return { ok: true, addresses }
}

async function requestOne (template: string, parameters: CcipRequestParameters, deps: CcipDeps, limits: CcipLimits, cancelled: AbortSignal | undefined): Promise<Hex> {
  const first = template.replace('{sender}', parameters.sender.toLowerCase()).replace('{data}', parameters.data)
  const post = !template.includes('{data}')
  const timeout = AbortSignal.timeout(limits.timeoutMs)
  const signal = cancelled === undefined ? timeout : AbortSignal.any([timeout, cancelled])
  let url = first
  for (let hops = 0; ; hops++) {
    const check = await checkUrl(url, deps)
    if (!check.ok) throw new EgressRefused(check.refusal)
    const init: RequestInit = post
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: parameters.data, sender: parameters.sender }), signal }
      : { method: 'GET', signal }
    // The URL and address checks above run either way; only the transport
    // differs, on a choice fixed for the whole run (CcipDeps.direct).
    const response = deps.direct
      ? await deps.directFetch(url, init, check.addresses)
      : await deps.fetch(url, { ...init, redirect: 'manual', credentials: 'omit' })
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      const next = location === null ? null : new URL(location, url).toString()
      const hopRefusal = next === null ? 'a redirect with no location' : redirectRefusal(first, next, hops)
      if (hopRefusal !== null || next === null) throw new EgressRefused(hopRefusal ?? 'a redirect with no location')
      url = next
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`${new URL(url).host} answered ${String(response.status)}`)
    }
    const bytes = await readCapped(response, limits.maxResponseBytes)
    const text = new TextDecoder().decode(bytes)
    const result: unknown = (response.headers.get('content-type') ?? '').startsWith('application/json') ? (JSON.parse(text) as { data?: unknown }).data : text
    if (typeof result !== 'string' || !HEX.test(result)) throw new Error(`${new URL(url).host} answered with something that is not hex`)
    return result as Hex
  }
}

/**
 * viem's CCIP-Read request, fenced: https only, port 443 only, every
 * address the host resolves to public unicast, a redirect only within the
 * same origin, and a size and time cap. With no proxy configured
 * (`deps.direct`), the request dials the address this module already
 * checked; with one configured, it goes through it by hostname instead,
 * the proxy's own resolution accepted rather than pinning around it (T20).
 * The resolver contract checks whatever comes back inside a proven call, so
 * this guards where the request goes, not what it returns.
 */
export async function guardedCcipRequest (parameters: CcipRequestParameters, deps: CcipDeps, limits: CcipLimits = DEFAULT_CCIP_LIMITS, signal?: AbortSignal): Promise<Hex> {
  const errors: string[] = []
  for (const template of parameters.urls.slice(0, MAX_URLS)) {
    signal?.throwIfAborted()
    try {
      return await requestOne(template, parameters, deps, limits, signal)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  throw new Error(`no offchain gateway answered: ${errors.join('; ') || 'no URL given'}`)
}
