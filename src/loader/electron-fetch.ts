// The real Fetch (fetch-bundle.ts's own type) over Electron's net.fetch --
// session-aware, unlike Node's global fetch.

import type { Fetch } from './fetch-bundle.js'

export const electronFetch: Fetch = async (url, signal) => {
  // Dynamically imported: outside a real Electron process (i.e. under
  // vitest), `electron`'s entry point is a path STRING, and a top-level
  // import would silently bind `undefined` rather than throw -- same
  // reasoning as main/favicon.ts and main/update-check-runner.ts.
  const { net } = await import('electron')
  // No try/catch, unlike favicon.ts's fetchFaviconDataUrl: that function's
  // contract is "never throws"; Fetch's contract is "reject on failure",
  // which fetch-bundle.ts's own callers already handle.
  //
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
