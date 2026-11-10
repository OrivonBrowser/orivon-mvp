// What the relay remembers of the names it looked up. Chromium's host cache is no longer the resolver while the relay is
// active, so the relay keeps its own. Pure: no `electron` import.

import type { AddressFamily } from './doh-message.js'

/** An answer is kept at most an hour. */
export const MAX_TTL_SECONDS = 3600
/** A name that was not found, or has no address of the family, is kept at most a minute (RFC 2308 lets a server say longer). */
export const MAX_NEGATIVE_TTL_SECONDS = 60
export const MAX_ENTRIES = 2000

/** An answer is chosen for where the query left from, so it is kept per name, family, DNS provider and proxy entry. */
export interface CacheKey {
  readonly name: string
  readonly family: AddressFamily
  readonly provider: string
  readonly via: string
}

export interface CachedResult {
  readonly addresses: readonly string[]
  readonly nxdomain: boolean
}

/** What one query came to, and the seconds the server said to keep it (before the caps above). */
export interface Fetched extends CachedResult {
  readonly ttl: number
}

export interface NameCache {
  /** The result for `key`: from memory, from the query already in flight for it, or from `fetch`. A rejection is passed on and kept by no one. */
  get: (key: CacheKey, fetch: () => Promise<Fetched>) => Promise<CachedResult>
  /** Forgets a name for both families, as when every address it gave failed. */
  drop: (key: Omit<CacheKey, 'family'>) => void
  /** Forgets everything, and keeps no answer that is still on its way. */
  clear: () => void
  size: () => number
}

const text = (key: CacheKey): string => `${key.provider}|${key.via}|${String(key.family)}|${key.name}`

export function createNameCache (options: { readonly now?: () => number } = {}): NameCache {
  const now = options.now ?? Date.now
  // Insertion order is recency order: a hit is moved to the end, and the first entry is the one dropped.
  const kept = new Map<string, { readonly result: CachedResult, readonly expires: number }>()
  const inFlight = new Map<string, Promise<CachedResult>>()
  let generation = 0

  async function fetchAndKeep (id: string, fetch: () => Promise<Fetched>): Promise<CachedResult> {
    const startedIn = generation
    const { ttl, ...result } = await fetch()
    const seconds = Math.min(ttl, result.addresses.length > 0 ? MAX_TTL_SECONDS : MAX_NEGATIVE_TTL_SECONDS)
    if (seconds > 0 && startedIn === generation) {
      kept.set(id, { result, expires: now() + seconds * 1000 })
      if (kept.size > MAX_ENTRIES) kept.delete(kept.keys().next().value as string)
    }
    return result
  }

  return {
    async get (key, fetch) {
      const id = text(key)
      const hit = kept.get(id)
      if (hit !== undefined) {
        kept.delete(id)
        if (hit.expires > now()) {
          kept.set(id, hit)
          return hit.result
        }
      }
      const pending = inFlight.get(id)
      if (pending !== undefined) return await pending
      const started = fetchAndKeep(id, fetch)
      inFlight.set(id, started)
      try {
        return await started
      } finally {
        if (inFlight.get(id) === started) inFlight.delete(id)
      }
    },
    drop (key) {
      for (const family of [4, 6] as const) {
        const id = text({ ...key, family })
        kept.delete(id)
        inFlight.delete(id)
      }
    },
    clear () {
      generation += 1
      kept.clear()
      inFlight.clear()
    },
    size: () => kept.size
  }
}
