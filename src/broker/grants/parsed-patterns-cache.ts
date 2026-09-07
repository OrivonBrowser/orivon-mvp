// Split out of ./grant-ledger.ts (code-guidelines.md Rule 2) when caching
// authorisedSend's (../index.ts) per-datagram checkConnect call pushed that
// file over 500 lines. A pure move: this is the one piece of GrantLedger's
// job that shares no state with the rest of it -- OriginRecord, storage,
// version floors and fs quotas all stay behind.

import type { Grant } from '../../contracts/index.js'
import type { ParsedPattern } from '../policy/connect-patterns.js'
import { parsePattern } from '../policy/connect-patterns.js'

export interface ParsedPatternsCache {
  /** `grant.patterns.map(parsePattern)`, computed once per Grant object and kept for its lifetime. */
  readonly get: (grant: Grant) => ReadonlyArray<ParsedPattern | null>
}

/**
 * Caches `parsePattern`'s output per Grant OBJECT rather than per
 * authorisation check -- checkConnect (policy/connect.ts) parses fresh on
 * every call, which is cheap once per TCP connection but ran once per UDP
 * PACKET when GrantLedger's own caller reused it unchanged for every
 * outbound datagram.
 *
 * A WeakMap keyed by the Grant object, not by (origin, capability) or
 * GrantId: `GrantLedger.grant` REPLACES a capability's record with a brand
 * new object rather than mutating the old one, and `revoke` removes it
 * outright, so a re-grant or a revoke both mean the ledger's own map now
 * points somewhere else (or nowhere) -- the same lookup that already decides
 * whether a grant is live at all also decides whether a cache entry here is
 * ever reachable again. There is deliberately no explicit invalidation step:
 * a stale entry for a superseded Grant simply becomes unreachable and
 * collectible, which is what makes this safe against A70's concern (a revoke
 * must stop the very next datagram, not just the next bind) without this
 * module knowing anything about that rule.
 */
export function createParsedPatternsCache (): ParsedPatternsCache {
  const cache = new WeakMap<Grant, ReadonlyArray<ParsedPattern | null>>()
  return {
    get (grant) {
      const cached = cache.get(grant)
      if (cached !== undefined) return cached
      const parsed = grant.patterns.map(parsePattern)
      cache.set(grant, parsed)
      return parsed
    }
  }
}
