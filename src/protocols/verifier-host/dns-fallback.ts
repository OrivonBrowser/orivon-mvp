// A251 (docs/open-questions.md): when a gateway is genuinely unreachable
// AND the system resolver's answer for it disagrees with a DNS-over-HTTPS
// one, reach it directly at the DoH address instead -- TLS still checked
// against the real hostname (direct-fetch.ts). Everything else keeps using
// Electron's `net`, so a configured proxy still applies to ordinary
// traffic; this exists only for the one case a lying resolver leaves with
// nothing else to try.

import { unlessAborted, withTimeout } from '../resolution/timing.js'
import type { WebFetch } from './egress.js'
import { DirectAnswerRefused } from './direct-fetch.js'
import type { DirectFetch } from './direct-fetch.js'

/** How long a route, once decided, is trusted before the next transport
 * failure re-checks it. `direct` lasts longer than `net`: the condition
 * that earned it (a lying resolver) is not something that fixes itself
 * quickly, while `net` deserves a shorter memory since it is the default
 * and the cheaper one to re-confirm. */
export const AGREED_FOR_MS = 5 * 60_000
export const DIRECT_FOR_MS = 10 * 60_000
/** How long either resolver may take to answer one comparison. */
const CHECK_TIMEOUT_MS = 5_000
/** Electron rejects `net.resolveHost` with the Chromium error's name as the message. */
const NAME_NOT_RESOLVED = /\bERR_NAME_NOT_RESOLVED\b/

type Route =
  | { readonly via: 'net', readonly until: number }
  | { readonly via: 'direct', readonly addresses: readonly string[], readonly until: number }

export interface DnsFallbackDeps {
  readonly fetch: WebFetch
  readonly direct: DirectFetch
  /** The system's own answer for `host` -- Electron's `net.resolveHost`,
   * ordinarily. */
  readonly systemAddresses: (host: string) => Promise<readonly string[]>
  /** Already public-unicast only, in canonical spelling (doh.ts's own `dohAddressResolver`). */
  readonly dohAddresses: (host: string, signal: AbortSignal) => Promise<readonly string[]>
  readonly now?: () => number
  readonly log?: (line: string) => void
}

function disjoint (a: readonly string[], b: readonly string[]): boolean {
  return !a.some((address) => b.includes(address))
}

/** The system resolver's answer. A name it says does not exist is `[]`,
 * the NXDOMAIN shape of tampering, so it counts as disagreeing (fail-open by
 * design). Any other failure (offline, timed out, a proxy error) is
 * `undefined`: nothing to compare, so never a reason to go direct. */
async function systemAnswersFor (host: string, systemAddresses: DnsFallbackDeps['systemAddresses']): Promise<readonly string[] | undefined> {
  try {
    return await withTimeout(systemAddresses(host), CHECK_TIMEOUT_MS, 'the system resolver')
  } catch (error) {
    return error instanceof Error && NAME_NOT_RESOLVED.test(error.message) ? [] : undefined
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

  /** The route decided for `origin`, while it is still in force. */
  const routeFor = (origin: string): Route | undefined => {
    const route = routes.get(origin)
    return route !== undefined && route.until > now() ? route : undefined
  }

  async function checkOrigin (origin: string, host: string): Promise<Route> {
    const existing = checks.get(origin)
    if (existing !== undefined) return await existing
    const check = (async (): Promise<Route> => {
      const [system, doh] = await Promise.all([
        systemAnswersFor(host, deps.systemAddresses),
        deps.dohAddresses(host, AbortSignal.timeout(CHECK_TIMEOUT_MS)).catch(() => [])
      ])
      if (system !== undefined && doh.length > 0 && disjoint(system, doh)) {
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

  // Only a transport failure of the direct attempt itself (refused, reset,
  // a bad certificate) sends the origin back to `net`. An attempt its caller
  // abandoned, or one that reached the gateway and refused its answer
  // (DirectAnswerRefused), says nothing about the route.
  async function tryDirect (origin: string, url: string, init: RequestInit | undefined, addresses: readonly string[]): Promise<Response> {
    try {
      return await deps.direct(url, init, addresses)
    } catch (error) {
      if (init?.signal?.aborted !== true && !(error instanceof DirectAnswerRefused)) {
        log(`${new URL(origin).hostname}: the direct connection failed too -- back to the system resolver`)
        routes.set(origin, { via: 'net', until: now() + AGREED_FOR_MS })
      }
      throw error
    }
  }

  return async (url, init) => {
    const parsed = new URL(url)
    const origin = parsed.origin
    if (!allowed.has(origin)) return await deps.fetch(url, init)

    const route = routeFor(origin)
    if (route?.via === 'direct') return await tryDirect(origin, url, init, route.addresses)

    try {
      return await deps.fetch(url, init)
    } catch (error) {
      if (init?.signal?.aborted === true) throw error
      // Read again rather than reusing `route`: a verdict another request
      // reached while this one was in flight is honoured, not re-checked,
      // and a recent 'net' verdict means no comparison until it expires.
      const decided = routeFor(origin) ?? await unlessAborted(checkOrigin(origin, parsed.hostname), init?.signal)
      if (decided.via === 'direct') return await tryDirect(origin, url, init, decided.addresses)
      throw error
    }
  }
}
