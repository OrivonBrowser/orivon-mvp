// How a local node turns a host name into addresses: over DNS-over-HTTPS
// first, so a resolver that hijacks a name cannot steer the node's TLS at a
// server that is not the one named, and through the system resolver only when
// no DoH endpoint answered, so a network that blocks DoH still works. This
// file only fetches addresses; node-net.ts decides which of them may be
// dialled, exactly as for the system resolver's answers.

import type { LookupAddress } from '../../contracts/index.js'
import { allowlisted } from '../gateways/allowlisted-fetch.js'
import type { WebFetch } from '../gateways/allowlisted-fetch.js'
import { dohHostAddresses } from '../gateways/doh-query.js'

/** Shortest and longest time an answer is kept: the DNS TTL, clamped. */
export const MIN_TTL_SECONDS = 10
export const MAX_TTL_SECONDS = 300
/** Names remembered at once; the oldest is dropped first. */
export const MAX_CACHED_NAMES = 256
/** After every endpoint failed, the system resolver answers alone for this long. */
export const DOH_PAUSE_MS = 60_000
/** A name both record types say has no address is remembered this long, so a retry storm does not become a query storm. */
export const NEGATIVE_TTL_SECONDS = 30
const QUERY_TIMEOUT_MS = 4_000

export interface NodeLookupOptions {
  /** The DNS-over-HTTPS endpoints, as main hands them over; none means the system resolver only. */
  readonly endpoints: readonly string[]
  /** The process's own fetch: the only requests it makes are to `endpoints`. */
  readonly fetch: WebFetch
  readonly system: (hostname: string) => Promise<readonly LookupAddress[]>
  readonly now?: () => number
  readonly queryTimeoutMs?: number
}

interface Cached {
  readonly answers: readonly LookupAddress[]
  readonly until: number
}

export function createNodeLookup (options: NodeLookupOptions): (hostname: string) => Promise<readonly LookupAddress[]> {
  if (options.endpoints.length === 0) return options.system
  const now = options.now ?? Date.now
  const doh = allowlisted(options.endpoints, options.fetch, 'a local node')
  const cache = new Map<string, Cached>()
  const inFlight = new Map<string, Promise<readonly LookupAddress[]>>()
  let pausedUntil = 0

  async function ask (hostname: string): Promise<readonly LookupAddress[]> {
    const { addresses: found, complete } = await dohHostAddresses(options.endpoints, doh, hostname, new AbortController().signal, options.queryTimeoutMs ?? QUERY_TIMEOUT_MS)
    const seen = new Set<string>()
    const answers: LookupAddress[] = []
    let ttl = found.length === 0 ? NEGATIVE_TTL_SECONDS : MAX_TTL_SECONDS
    for (const { address, family, ttlSeconds } of found) {
      if (seen.has(address)) continue
      seen.add(address)
      answers.push({ address, family })
      if (ttlSeconds !== undefined) ttl = Math.min(ttl, ttlSeconds)
    }
    // A family that could not be asked may hold the address the node needs, so what the other said is used once and not kept.
    if (complete) {
      if (cache.size >= MAX_CACHED_NAMES) cache.delete(cache.keys().next().value as string)
      cache.set(hostname, { answers, until: now() + 1000 * Math.max(MIN_TTL_SECONDS, ttl) })
    }
    return answers
  }

  async function resolve (hostname: string): Promise<readonly LookupAddress[]> {
    try {
      return await ask(hostname)
    } catch {
      pausedUntil = now() + DOH_PAUSE_MS
      return await options.system(hostname)
    }
  }

  return async (hostname) => {
    const key = hostname.toLowerCase()
    const cached = cache.get(key)
    if (cached !== undefined && cached.until > now()) return cached.answers
    if (now() < pausedUntil) return await options.system(hostname)
    let pending = inFlight.get(key)
    if (pending === undefined) {
      pending = resolve(key).finally(() => { inFlight.delete(key) })
      inFlight.set(key, pending)
    }
    return await pending
  }
}
