// The real Fetch (fetch-bundle.ts's own type) over Electron's net.fetch --
// session-aware, unlike Node's global fetch.

import type { Fetch } from './fetch-bundle.js'
import { classifyAddress, isPublicUnicast } from '../broker/policy/address.js'

export const electronFetch: Fetch = async (url, pinnedAddresses, signal) => {
  // Dynamically imported: outside a real Electron process (i.e. under
  // vitest), `electron`'s entry point is a path STRING, and a top-level
  // import would silently bind `undefined` rather than throw -- same
  // reasoning as main/favicon.ts and main/update-check-runner.ts.
  const { net } = await import('electron')

  // F2, RESIDUAL: `pinnedAddresses` is install-origin.ts's validated literal
  // set -- resolved, as of this fix, via `electron-resolve.ts`'s
  // `electronResolveHost` (Chromium's own `net.resolveHost`, the SAME
  // resolver and default session `net.fetch` below will itself consult), NOT
  // node-adapters.ts's node:dns-based one. That closes the ROOT cause of F2
  // (guard and fetch disagreeing because they were answered by two entirely
  // different resolvers/caches) rather than only papering over it here.
  //
  // What is NOT closed, and cannot be with Electron's current API surface:
  // neither `net.fetch` nor `net.request` exposes a way to pin a request's
  // underlying connection to a specific resolved address while keeping the
  // real hostname for TLS SNI/the Host header/`response.url` -- confirmed
  // directly against node_modules/electron/electron.d.ts (2026-09-05,
  // electron 44): `request.setHeader` explicitly refuses `Host` (Chromium's
  // own header_util.cc), `--host-resolver-rules` is a startup-only global
  // command-line switch, not a per-request option, and neither `net.fetch`'s
  // `Response` nor `ClientRequest`'s `response`/`IncomingMessage` exposes the
  // remote address a request actually connected to. Rewriting `url` to the
  // IP literal instead would break TLS/SNI for every real https host AND
  // fetch-bundle.ts's own same-origin check (`originFromUrl(response.url) ===
  // canonicalOrigin`), which can never hold for an IP-literal response.url --
  // so that is not an option either. Recorded as docs/open-questions.md A66;
  // this comment, not that one, is the one to keep current if Electron ever
  // adds such a hook.
  //
  // What IS still done here, on top of the shared resolver above: re-resolve
  // via `net.resolveHost` immediately before THIS request, and refuse if the
  // host no longer resolves as public. F5's asset loop can run for up to
  // BUNDLE_TIMEOUT_MS (10 minutes) after the guard's own resolution; this
  // re-check is what keeps each of possibly many later fetches honest against
  // a resolution that changed (a TTL genuinely expiring, or a rebinding
  // attacker exploiting exactly that) since the guard ran, without ever
  // re-introducing a second, DIFFERENT resolver into the picture. Residual
  // window: purely temporal now (between this call and net.fetch's own
  // resolution a moment later, against the same resolver/cache) -- not the
  // "different resolver stack entirely" gap F2 was filed for.
  // `pinnedAddresses` itself is not compared literal-for-literal here on
  // purpose: an ordinary CDN may legitimately rotate to a different, still-
  // public address between the guard and this call, and rejecting that would
  // break real installs for no security gain -- the property that matters is
  // "still public", not "still this exact address".
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

  // credentials: 'omit' -- this fetches content from an origin the app has
  // no established session relationship with yet; no cookie should ever be
  // read from or written to a store on its behalf here.
  //
  // SESSION UNSPECIFIED, AI-REC not an owner decision: no `session` option
  // means Electron's default session. Once per-app partitions land, this
  // may need the confirmed app's own partitioned session instead.
  //
  // redirect: 'error' -- this closes the REDIRECT-specific vector, and only
  // that one. Electron's own net-client-request.ts source causes a hard
  // promise REJECTION the instant a redirect response is seen, so a
  // malicious redirect can never produce a followed Response for
  // fetch-bundle.ts to inspect at all -- the fetch call fails before there
  // is a Response, let alone a `.url` on one, so this mechanism does not
  // depend on `.url` being accurate. 'error' also has the practical
  // advantage over 'manual' of not handing fetch-bundle.ts a manual-redirect
  // Response shape it has no code to interpret; the loader never expects a
  // redirect in the first place (the manifest is always fetched from one
  // fixed URL, assets resolve against the app's own origin), so failing
  // closed here costs nothing.
  //
  // WHAT THIS DOES NOT CLOSE: node_modules/electron/electron.d.ts documents
  // the `.type` and `.url` of net.fetch's returned Response as INCORRECT --
  // an UNCONDITIONAL limitation of net.fetch, not one scoped to redirects
  // (confirmed directly in the installed .d.ts; neither it nor context7 says
  // more about what is actually wrong or when). fetch-bundle.ts's same-origin
  // and canonical-path checks read response.url on EVERY fetch, redirected or
  // not. Whether `.url` can be inaccurate on an ordinary, non-redirected,
  // 200-OK fetch -- and what that would mean for those checks -- is NOT
  // resolved by this option and is not researched here. Tracked as
  // docs/open-questions.md A59; do not read this comment as having closed
  // that question.
  return await net.fetch(url, { credentials: 'omit', signal, redirect: 'error' })
}
