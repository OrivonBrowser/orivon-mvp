// A fetch that reaches only a fixed list of origins and follows no redirect.
// The verifier host's every fixed endpoint goes through one, and so does a
// local node's DNS-over-HTTPS lookup (local-node/node-dns.ts).

import { RedirectRefused } from './gateways.js'

export type WebFetch = (url: string, init?: RequestInit) => Promise<Response>

export class EgressRefused extends Error {
  override readonly name = 'EgressRefused'
}

/**
 * A fetch that reaches only `origins`, and follows no redirect: a
 * configured endpoint that redirects elsewhere would otherwise take the
 * request with it. The redirect is asked for as a response and thrown as a
 * `RedirectRefused`, so a caller can tell it from a connection that failed.
 */
export function allowlisted (origins: readonly string[], fetch: WebFetch, label: string): WebFetch {
  const allowed = new Set(origins.map((o) => new URL(o).origin))
  return async (url, init) => {
    const origin = new URL(url).origin
    if (!allowed.has(origin)) throw new EgressRefused(`${label} may not reach ${origin}`)
    let response: Response
    try {
      response = await fetch(url, { ...init, redirect: 'manual' })
    } catch (error) {
      // Electron's net.fetch yields no 3xx response for a manual redirect: nothing calls followRedirect, so the
      // request dies with exactly this message.
      if (error instanceof Error && error.message === 'Redirect was cancelled') throw new RedirectRefused(`${new URL(url).host} answered with a redirect, which is not followed`)
      throw error
    }
    // A manual redirect is a 3xx, or an opaque filtered response of status 0.
    if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
      await response.body?.cancel()
      throw new RedirectRefused(`${new URL(url).host} answered with a redirect, which is not followed`)
    }
    return response
  }
}
