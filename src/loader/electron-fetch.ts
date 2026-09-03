// The real Fetch (fetch-bundle.ts's own type) over Electron's net.fetch --
// session-aware, unlike Node's global fetch. Imported dynamically, same
// reasoning as main/favicon.ts and main/update-check-runner.ts: outside a
// real Electron process (i.e. under vitest), `electron`'s entry point is a
// path STRING, and a top-level import would silently bind `undefined`
// rather than throw.
//
// NO TRY/CATCH HERE, unlike favicon.ts's fetchFaviconDataUrl -- that
// function's contract is "never throws, null on any failure"; this one's
// contract (Fetch) is "reject on failure", which fetch-bundle.ts's own
// callers already handle. Wrapping it here would just be a second, silently
// divergent error contract for the same call.
//
// NOT UNIT-TESTED DIRECTLY, matching fetchFaviconDataUrl's own precedent:
// its whole body is the dynamic import plus one delegated call, and there is
// no established way to stub Electron's `net` module in this codebase (the
// pure logic it wraps -- fetch-bundle.ts's budget/timeout/validation code --
// is already exhaustively tested against a stub Fetch). Exercised for real
// once loaderSubsystem's afterReady constructs a Loader with it.
//
// SESSION UNSPECIFIED, AI-REC not yet an owner decision: `net.fetch` with no
// `session` option uses Electron's default session. Once per-app partitions
// land (a later PR in this same push), this may need to move to the
// confirmed app's own partitioned session -- flagged here rather than
// assumed, since nothing in the corpus states which session an install-time
// fetch should run in.

import type { Fetch } from './fetch-bundle.js'

export const electronFetch: Fetch = async (url, signal) => {
  const { net } = await import('electron')
  // credentials: 'omit', matching favicon.ts's own precedent for the
  // identical reason -- this fetches content from an origin the app has no
  // established session relationship with yet; no cookie should ever be
  // read from or written to a store on its behalf here.
  return await net.fetch(url, { credentials: 'omit', signal })
}
