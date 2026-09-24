// Every request the verifier host makes leaves through one of these. A fixed
// endpoint list gets `allowlisted`; a URL chosen by a name's resolver
// contract gets `guardedCcipRequest`. Anything else throws.

import type { Hex } from 'viem'
import { classifyAddress, isPublicUnicast } from '../broker/policy/address.js'
import { redirectRefusal } from '../loader/electron-fetch.js'
import { readCapped } from '../ipfs/gateways.js'
import type { CcipRequestParameters } from '../ens/resolver.js'

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
  /** A fetch that returns a 3xx as a response, never following it. */
  readonly fetch: WebFetch
}

export interface CcipLimits {
  readonly maxResponseBytes: number
  readonly timeoutMs: number
}

export const DEFAULT_CCIP_LIMITS: CcipLimits = { maxResponseBytes: 1024 * 1024, timeoutMs: 10_000 }

const MAX_URLS = 8
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/

/** Why a URL may not be requested at all, or null. */
async function urlRefusal (raw: string, deps: CcipDeps): Promise<string | null> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return `not a URL: ${raw}`
  }
  if (url.protocol !== 'https:') return `only https is allowed, not ${url.protocol}`
  if (url.username !== '' || url.password !== '') return 'credentials in the URL'
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (classifyAddress(host) !== 'unparseable') return isPublicUnicast(host) ? null : `${host} is not a public address`
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.eth')) return `${host} is not a public name`
  const addresses = await deps.resolveHost(host)
  if (addresses.length === 0) return `${host} resolved to no address`
  const private_ = addresses.find((a) => !isPublicUnicast(a))
  return private_ === undefined ? null : `${host} resolves to ${private_}, which is not a public address`
}

async function requestOne (template: string, parameters: CcipRequestParameters, deps: CcipDeps, limits: CcipLimits, cancelled: AbortSignal | undefined): Promise<Hex> {
  const first = template.replace('{sender}', parameters.sender.toLowerCase()).replace('{data}', parameters.data)
  const post = !template.includes('{data}')
  const timeout = AbortSignal.timeout(limits.timeoutMs)
  const signal = cancelled === undefined ? timeout : AbortSignal.any([timeout, cancelled])
  let url = first
  for (let hops = 0; ; hops++) {
    const refusal = await urlRefusal(url, deps)
    if (refusal !== null) throw new EgressRefused(refusal)
    const response = await deps.fetch(url, post
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: parameters.data, sender: parameters.sender }), signal, redirect: 'manual' }
      : { method: 'GET', signal, redirect: 'manual' })
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
 * viem's CCIP-Read request, fenced: https only, every address the host
 * resolves to public unicast, a redirect only within the same origin, and
 * a size and time cap. The resolver contract checks whatever comes back
 * inside a proven call, so this guards where the request goes, not what it
 * returns.
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
