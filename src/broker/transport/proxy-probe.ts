// Wires `CreateBrokerOptions['proxyConfigured']` (../broker-contracts.ts) to
// a real proxy lookup for T20's fail-closed check -- ./ipc.ts's own
// `afterReady` is the one place that injects `session.defaultSession.
// resolveProxy` itself; this file adds the caching and the timeout around
// whatever `resolveProxy` it is given, so that decision is testable under
// plain vitest with no `electron` import, the way `relay/`'s own pumps are
// (../transport/README.md).

import type { ProxyProbe } from '../broker-contracts.js'

/**
 * How long one `resolveProxy` call may take before it counts as "a proxy
 * applies" -- fails closed, the same direction a thrown error takes: a
 * system that cannot even answer "is there a proxy" is not one a net
 * capability should treat as proxy-free.
 */
const PROXY_PROBE_TIMEOUT_MS = 2_000

/**
 * How long one URL's answer is reused. `udp.send`'s own per-datagram check
 * (../capabilities/net.ts) can run hundreds of times a second against one
 * steady peer, and a `resolveProxy` round trip on every packet is real,
 * avoidable cost -- the same reasoning that file's own comment gives for
 * caching a grant's parsed patterns rather than re-parsing them per packet.
 * Short enough that a proxy switched on mid-run is seen well within one
 * interactive session (A262 raises the same staleness question for the
 * verifier's own snapshot).
 */
const CACHE_TTL_MS = 5_000

async function resolveWithTimeout (resolveProxy: (url: string) => Promise<string>, url: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      resolveProxy(url),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error('the proxy check took too long')) }, PROXY_PROBE_TIMEOUT_MS)
        timer.unref()
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Turns a raw `resolveProxy(url)` -- Chromium's own wording, the literal
 * `'DIRECT'` for "nothing applies here", anything else naming a proxy or a
 * PAC failure -- into `ProxyProbe`'s fail-closed boolean, cached per URL for
 * `CACHE_TTL_MS`. `now` is injected only so a test can control the clock;
 * every real caller omits it.
 */
export function cachingProxyProbe (resolveProxy: (url: string) => Promise<string>, now: () => number = Date.now): ProxyProbe {
  const cache = new Map<string, { readonly proxied: boolean, readonly expiresAt: number }>()

  return async (url) => {
    const cached = cache.get(url)
    if (cached !== undefined && cached.expiresAt > now()) return cached.proxied

    let proxied: boolean
    try {
      proxied = (await resolveWithTimeout(resolveProxy, url)).trim() !== 'DIRECT'
    } catch {
      proxied = true
    }

    cache.set(url, { proxied, expiresAt: now() + CACHE_TTL_MS })
    return proxied
  }
}
