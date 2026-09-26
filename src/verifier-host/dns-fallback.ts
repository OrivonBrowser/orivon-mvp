// A251 (docs/open-questions.md): when a gateway is genuinely unreachable
// AND the system resolver's answer for it disagrees with a DNS-over-HTTPS
// one, reach it directly at the DoH address instead -- TLS still checked
// against the real hostname (direct-fetch.ts). Everything else keeps using
// Electron's `net`, so a configured proxy still applies to ordinary
// traffic; this exists only for the one case a lying resolver leaves with
// nothing else to try.

import type { WebFetch } from './egress.js'
import type { DirectFetch } from './direct-fetch.js'

/** How long a route, once decided, is trusted before the next transport
 * failure re-checks it. `direct` lasts longer than `net`: the condition
 * that earned it (a lying resolver) is not something that fixes itself
 * quickly, while `net` deserves a shorter memory since it is the default
 * and the cheaper one to re-confirm. */
export const AGREED_FOR_MS = 5 * 60_000
export const DIRECT_FOR_MS = 10 * 60_000

type Route =
  | { readonly via: 'net', readonly until: number }
  | { readonly via: 'direct', readonly addresses: readonly string[], readonly until: number }

export interface DnsFallbackDeps {
  readonly fetch: WebFetch
  readonly direct: DirectFetch
  /** The system's own answer for `host` -- Electron's `net.resolveHost`,
   * ordinarily. A rejection is treated the same as an empty answer: NXDOMAIN
   * tampering is exactly the shape this exists to catch. */
  readonly systemAddresses: (host: string) => Promise<readonly string[]>
  /** Already public-unicast only (doh.ts's own `dohAddressResolver`). */
  readonly dohAddresses: (host: string, signal: AbortSignal) => Promise<readonly string[]>
  readonly now?: () => number
  readonly log?: (line: string) => void
}

function disjoint (a: readonly string[], b: readonly string[]): boolean {
  return !a.some((address) => b.includes(address))
}

async function systemAnswersFor (host: string, systemAddresses: DnsFallbackDeps['systemAddresses']): Promise<readonly string[]> {
  try {
    return await systemAddresses(host)
  } catch {
    return [] // an NXDOMAIN or a resolver error is exactly the tampering shape this checks for
  }
}

/**
 * Wraps `deps.fetch` so that a transport failure (never an HTTP status) to
 * one of `origins` triggers a one-time comparison: the system resolver's
 * addresses for that host against a DNS-over-HTTPS one. Disjoint, and the
 * DoH answer is non-empty, switches that origin to a direct connection at
 * the DoH addresses for `DIRECT_FOR_MS` and retries the request once;
 * anything else remembers "no need to check again" for `AGREED_FOR_MS` and
 * rethrows the original failure, letting the caller's own retry/hedge
 * logic (block-fetch.ts) decide what to do next.
 */
export function withDnsFallback (origins: readonly string[], deps: DnsFallbackDeps): WebFetch {
  const allowed = new Set(origins.map((o) => new URL(o).origin))
  const routes = new Map<string, Route>()
  const checks = new Map<string, Promise<Route>>()
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})

  async function checkOrigin (origin: string, host: string): Promise<Route> {
    const existing = checks.get(origin)
    if (existing !== undefined) return await existing
    const check = (async (): Promise<Route> => {
      const [system, doh] = await Promise.all([
        systemAnswersFor(host, deps.systemAddresses),
        deps.dohAddresses(host, AbortSignal.timeout(5_000)).catch(() => [])
      ])
      if (doh.length > 0 && disjoint(system, doh)) {
        log(`${host}: system resolver (${system.join(', ') || 'nothing'}) disagrees with DNS-over-HTTPS (${doh.join(', ')}) -- reaching it directly`)
        return { via: 'direct', addresses: doh, until: now() + DIRECT_FOR_MS }
      }
      return { via: 'net', until: now() + AGREED_FOR_MS }
    })()
    checks.set(origin, check)
    try {
      const route = await check
      routes.set(origin, route)
      return route
    } finally {
      checks.delete(origin)
    }
  }

  // A direct attempt that itself fails resets the route to `net` before
  // rethrowing -- whether this was the fast path (already routed direct)
  // or the very call that just decided to try direct for the first time.
  // One place, so both mean the same thing (Rule 3): a direct route never
  // survives its own failure, however it was reached.
  async function tryDirect (origin: string, url: string, init: RequestInit | undefined, addresses: readonly string[]): Promise<Response> {
    try {
      return await deps.direct(url, init, addresses)
    } catch (error) {
      routes.set(origin, { via: 'net', until: now() + AGREED_FOR_MS })
      throw error
    }
  }

  return async (url, init) => {
    const parsed = new URL(url)
    const origin = parsed.origin
    if (!allowed.has(origin)) return await deps.fetch(url, init)

    const route = routes.get(origin)
    if (route !== undefined && route.via === 'direct' && route.until > now()) {
      return await tryDirect(origin, url, init, route.addresses)
    }

    try {
      return await deps.fetch(url, init)
    } catch (error) {
      if (init?.signal?.aborted === true) throw error
      // A recent 'net' verdict ("checked, they agree") is honoured here too,
      // not just a 'direct' one above -- without this, every subsequent
      // transport failure re-ran the full system-vs-DoH comparison instead
      // of remembering the answer for AGREED_FOR_MS, which was the whole
      // point of recording it.
      if (route !== undefined && route.via === 'net' && route.until > now()) throw error
      const decided = await checkOrigin(origin, parsed.hostname)
      if (decided.via === 'direct') return await tryDirect(origin, url, init, decided.addresses)
      throw error
    }
  }
}
