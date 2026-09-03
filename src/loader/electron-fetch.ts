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
  // redirect: 'error' -- node_modules/electron/electron.d.ts documents the
  // `.url` (and `.type`) of net.fetch's returned Response as INCORRECT.
  // fetch-bundle.ts's entire same-origin check trusts response.url as the
  // only source of truth for where fetched bytes actually came from
  // (deliberately rejecting the originally-requested url for that purpose,
  // per its own comment) -- so a redirect silently followed onto a
  // different origin would be judged same-origin or not using a field
  // Electron itself says may not be accurate. 'error' refuses outright
  // rather than 'manual', which would hand fetch-bundle.ts a manual-redirect
  // Response shape it has no code to interpret; the loader never expects a
  // redirect in the first place (the manifest is always fetched from one
  // fixed URL, assets resolve against the app's own origin), so failing
  // closed here costs nothing.
  return await net.fetch(url, { credentials: 'omit', signal, redirect: 'error' })
}
