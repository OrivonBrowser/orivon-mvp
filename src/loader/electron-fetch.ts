// The real Fetch (fetch-bundle.ts's own type) over Electron's net.fetch --
// session-aware, unlike Node's global fetch.

import { Readable } from 'node:stream'
import type { IncomingMessage } from 'electron'
import type { Fetch, FetchResponse } from './fetch-bundle.js'
import { originFromUrl } from '../broker/policy/origin.js'
import { classifyAddress, isPublicUnicast } from '../broker/policy/address.js'

export const electronFetch: Fetch = async (url, pinnedAddresses, signal) => {
  // Dynamically imported: outside a real Electron process (i.e. under
  // vitest), `electron`'s entry point is a path STRING, and a top-level
  // import would silently bind `undefined` rather than throw -- same
  // reasoning as main/favicon.ts and main/update-check-runner.ts.
  const { net } = await import('electron')

  // `pinnedAddresses` is install-origin.ts's validated literal set, resolved
  // via `electron-resolve.ts`'s `electronResolveHost` (Chromium's own
  // `net.resolveHost`, the SAME resolver and default session `net.fetch`
  // below will itself consult) -- never node-adapters.ts's node:dns-based
  // one, so the guard and the fetch can no longer disagree about what a
  // hostname resolves to.
  //
  // WHAT IS NOT CLOSED, AND CANNOT BE WITH ELECTRON'S CURRENT API SURFACE:
  // neither `net.fetch` nor `net.request` exposes a way to pin a request's
  // underlying connection to a specific resolved address while keeping the
  // real hostname for TLS SNI/the Host header (confirmed against
  // node_modules/electron/electron.d.ts, electron 44): `request.setHeader`
  // explicitly refuses `Host`, `--host-resolver-rules` is a startup-only
  // global switch, not a per-request option, and neither `net.fetch`'s
  // `Response` nor `ClientRequest`'s own response exposes the remote address
  // a request actually connected to. Rewriting `url` to the IP literal
  // instead would break TLS/SNI for every real https host AND
  // fetch-bundle.ts's own same-origin check (A141: derived from this
  // REQUESTED url, so an IP-literal `url` could never match `canonicalOrigin`
  // either) -- so that is not an option either. Tracked as
  // docs/open-questions.md A66 -- this comment, not that entry, is what to
  // update if Electron ever adds such a hook.
  //
  // What IS still done here, on top of the shared resolver above:
  // re-resolve via `net.resolveHost` immediately before THIS request, and
  // refuse if the host no longer resolves as public. The asset loop can run
  // for up to BUNDLE_TIMEOUT_MS (30 minutes) after the guard's own
  // resolution; this re-check is what keeps each of possibly many later
  // fetches honest against a resolution that changed (a TTL genuinely
  // expiring, or a rebinding attacker exploiting exactly that) since the
  // guard ran. Residual window: purely temporal now (between this call and
  // net.fetch's own resolution a moment later, against the same
  // resolver/cache).
  //
  // `pinnedAddresses` itself is not compared literal-for-literal here on
  // purpose: an ordinary CDN may legitimately rotate to a different, still-
  // public address between the guard and this call, and rejecting that
  // would break real installs for no security gain -- the property that
  // matters is "still public", not "still this exact address".
  const hostname = new URL(url).hostname
  if (classifyAddress(hostname) === 'unparseable') {
    const resolved = await net.resolveHost(hostname)
    if (resolved.endpoints.length === 0) {
      throw new Error(`install origin's host resolved to no addresses immediately before fetching: ${hostname}`)
    }
    for (const endpoint of resolved.endpoints) {
      if (!isPublicUnicast(endpoint.address)) {
        throw new Error(`install origin's host no longer resolves to a public address immediately before fetching: ${hostname}`)
      }
    }
  } else if (pinnedAddresses.length === 0 || !isPublicUnicast(hostname)) {
    // Defensive only: fetch-bundle.ts never reaches here with a literal host
    // the guard did not already accept, and a literal has nothing to
    // re-resolve. Kept so this function's own contract does not silently
    // depend on that invariant holding forever.
    throw new Error(`install origin's host is not a public address literal: ${hostname}`)
  }

  return await netFetch(url, signal)
}

/** Redirect hops one asset fetch may follow. A static host needs one or two (`/index.html` -> `/`, `/app` -> `/app/`). */
export const MAX_REDIRECTS = 5

/**
 * Why a redirect from `requestedUrl` to `redirectUrl` must not be followed,
 * or null if it may: it stays on the requested origin (scheme, host and
 * port), and fewer than MAX_REDIRECTS hops have been taken. A cross-origin
 * hop is refused because fetch-bundle.ts pins every asset under the url it
 * REQUESTED (A141): only a same-origin hop keeps that true of the bytes.
 */
export function redirectRefusal (requestedUrl: string, redirectUrl: string, hopsTaken: number): string | null {
  if (hopsTaken >= MAX_REDIRECTS) return `more than ${String(MAX_REDIRECTS)} redirects from ${requestedUrl}`
  const from = originFromUrl(requestedUrl)
  const to = originFromUrl(redirectUrl)
  if (from === null || to !== from) return `redirected to another origin (${to ?? redirectUrl}) from ${requestedUrl}`
  return null
}

/** Electron's IncomingMessage as the minimal `FetchResponse` fetch-budget.ts reads. */
function toFetchResponse (url: string, response: IncomingMessage): FetchResponse {
  const body = Readable.toWeb(response as unknown as Readable) as ReadableStream<Uint8Array>
  return {
    ok: response.statusCode >= 200 && response.statusCode < 300,
    status: response.statusCode,
    url,
    headers: {
      get: (name) => {
        const value = response.headers[name.toLowerCase()]
        return value === undefined ? null : Array.isArray(value) ? value.join(', ') : value
      }
    },
    body,
    arrayBuffer: async () => await new Response(body).arrayBuffer()
  }
}

/**
 * The exact fetch electronFetch makes once the address guard above has
 * passed -- exported separately so a test can exercise its redirect handling
 * against a real server without also having to satisfy that guard, which no
 * local test server can ever pass (T12/A46 refuses every loopback literal).
 * See test/e2e-loader-adapter.test.ts.
 *
 * `net.request`, not `net.fetch`: `net.fetch` offers only `redirect:
 * 'error'` (every redirect fails, including the `/index.html` -> `/` hop
 * Cloudflare Pages and Vercel answer with) or `'follow'` (a hop to anywhere
 * is followed unseen, and its `Response.url` is '' either way, A59/A141).
 * With `redirect: 'manual'` each hop is shown to `redirectRefusal` before
 * it is taken, and anything it refuses aborts the request -- so a response
 * reaching fetch-bundle.ts always came from the requested origin. CHANGING
 * THIS SILENTLY REOPENS THAT (`Fetch`'s own doc, fetch-budget.ts).
 *
 * credentials: 'omit' -- no cookie is read or written on the app's behalf
 * before it has any session relationship. No `session` option: Electron's
 * default session (AI recommendation, not an owner decision).
 */
export async function netFetch (url: string, signal: AbortSignal): Promise<FetchResponse> {
  const { net } = await import('electron')
  return await new Promise<FetchResponse>((resolve, reject) => {
    const request = net.request({ url, method: 'GET', credentials: 'omit', useSessionCookies: false, redirect: 'manual' })
    let hops = 0
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      request.abort()
      reject(error)
    }
    request.on('redirect', (_status, _method, redirectUrl) => {
      const refusal = redirectRefusal(url, redirectUrl, hops)
      if (refusal !== null) { fail(new Error(refusal)); return }
      hops += 1
      request.followRedirect()
    })
    request.on('response', (response) => {
      if (settled) return
      settled = true
      resolve(toFetchResponse(url, response))
    })
    request.on('error', (error) => { fail(error) })
    if (signal.aborted) { fail(new Error('aborted')); return }
    // Also after settling: aborting then tears down a body still streaming.
    signal.addEventListener('abort', () => { request.abort(); fail(new Error('aborted')) }, { once: true })
    request.end()
  })
}
