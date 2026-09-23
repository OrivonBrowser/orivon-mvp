// Redirect hops on the third-party reach path. A 3xx the handler returns is
// followed by the page's own loader, back through the same handler, so each
// hop is authorised afresh against the live grant, redirect:'manual' works,
// connect-src is re-checked and Authorization is dropped cross-origin -- but
// that loader applies no redirect cap to a protocol.handle response
// (measured, test/e2e-served-csp.test.ts). This file supplies the cap.

/** Redirects one chain may take through the handler: the Fetch standard's own limit. */
export const MAX_REACH_REDIRECTS = 20

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

/** How long a recorded hop waits for the page's loader to request its target. */
const HOP_TTL_MS = 60_000

/** Oldest entries are dropped past this; a dropped chain restarts its count, never blocks. */
const MAX_TRACKED_HOPS = 1024

export interface RedirectChains {
  /** How many redirects led to `url`: 0 for a URL no redirect of this handler's pointed at. */
  depthOf: (url: string) => number
  /** Records that a request `depth` redirects deep was itself redirected to `target`. */
  record: (target: string, depth: number) => void
  forget: (url: string) => void
}

export function createRedirectChains (now: () => number = Date.now): RedirectChains {
  const hops = new Map<string, { readonly depth: number, readonly at: number }>()
  return {
    depthOf: (url) => {
      const hop = hops.get(url)
      if (hop === undefined) return 0
      if (now() - hop.at > HOP_TTL_MS) {
        hops.delete(url)
        return 0
      }
      return hop.depth
    },
    record: (target, depth) => {
      hops.delete(target)
      hops.set(target, { depth, at: now() })
      if (hops.size > MAX_TRACKED_HOPS) {
        const oldest = hops.keys().next()
        if (oldest.done !== true) hops.delete(oldest.value)
      }
    },
    forget: (url) => { hops.delete(url) }
  }
}

/**
 * The URL the page's loader will request next when `response` is a redirect
 * it follows, or `undefined`. Resolved against `requestUrl` and without a
 * fragment, the form the follow-up request reaches the handler in.
 */
export function redirectTarget (response: Response, requestUrl: string): string | undefined {
  if (!REDIRECT_STATUSES.has(response.status)) return undefined
  const location = response.headers.get('location')
  if (location === null) return undefined
  try {
    const target = new URL(location, requestUrl)
    target.hash = ''
    return target.href
  } catch {
    return undefined
  }
}
