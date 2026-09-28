// Which pinned asset, if any, a same-origin request answers to -- the
// path-to-asset half of serve.ts, split out (Rule 2) and exported for
// direct, Electron-free unit testing. See README.md's Design notes for the
// root, subdirectory-entry and history-fallback rules.

import { canonicalAssetPath } from '../../broker/policy/canonical-path.js'
import { isPinnedPath } from '../../broker/policy/pin.js'
import type { PinRecord } from '../../broker/policy/pin.js'

/** Everything a request needs decided before a byte is read off disk. */
export type ResolvedRequest =
  | { readonly ok: true, readonly canonicalPath: string, readonly retainedLeaf?: string }
  | { readonly ok: true, readonly redirectTo: string }
  | { readonly ok: false, readonly reason: string }

/**
 * Is this a document navigation (a tab, a frame, a reload) rather than a
 * subresource or `fetch()`? `protocol.handle` hands over a Request whose
 * `mode` is always 'cors' and whose `destination` is always '', with no
 * `Sec-Fetch-*` headers (measured, Electron 44); what does tell them apart
 * is Chromium's own navigation headers: `Upgrade-Insecure-Requests: 1` and
 * an `Accept` naming `text/html`, which subresource requests do not send.
 * `Sec-Fetch-Mode` wins whenever a later Electron does supply it. A page can
 * forge both headers on its own `fetch()`, which only gets it the entry
 * document -- a pinned asset it could fetch directly anyway.
 */
export function isNavigationRequest (request: Request): boolean {
  const mode = request.headers.get('sec-fetch-mode')
  if (mode !== null) return mode === 'navigate'
  return request.headers.get('upgrade-insecure-requests') === '1' && (request.headers.get('accept') ?? '').includes('text/html')
}

/** `/settings`, `/user/42/` -- a route, not a file: its last segment has no `.`. */
function looksLikeRoute (pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf('/') + 1)
  return !last.includes('.')
}

/**
 * Every path must be an EXACT pinned canonical path -- ADR-0007's fail-closed
 * rule, "a same-origin request whose path is not in the pinned set is
 * denied, not fetched" -- with two exceptions, both answered with the
 * pinned entry and never with anything unpinned:
 *
 * - `/` maps to `manifest.entry`. An entry in a subdirectory is REDIRECTED
 *   to rather than served at `/`, so the document's relative URLs resolve
 *   against its own directory.
 * - A NAVIGATION to an unpinned route (no file extension) serves the entry,
 *   the history fallback every SPA host provides: a reload of a client-side
 *   route must not 404. A subresource or `fetch()` for the same path is
 *   still denied.
 *
 * `retained` (path -> leaf) are a previous pin's files this process served
 * before an update: still answered, as `retainedLeaf`, which the caller must
 * check the bytes against before serving them.
 */
export function resolveRequestPath (
  entryPath: string | null,
  pin: PinRecord,
  requestUrl: string,
  navigation = false,
  retained?: ReadonlyMap<string, string>
): ResolvedRequest {
  const url = new URL(requestUrl)
  const entryPinned = entryPath !== null && isPinnedPath(pin, entryPath)

  if (url.pathname === '/') {
    if (!entryPinned) return { ok: false, reason: 'entry point is not part of the pinned bundle' }
    return entryPath.lastIndexOf('/') > 0 ? { ok: true, redirectTo: entryPath } : { ok: true, canonicalPath: entryPath }
  }

  const canonicalPath = canonicalAssetPath(requestUrl)
  if (canonicalPath !== null && isPinnedPath(pin, canonicalPath)) return { ok: true, canonicalPath }
  const retainedLeaf = canonicalPath === null ? undefined : retained?.get(canonicalPath)
  if (canonicalPath !== null && retainedLeaf !== undefined) return { ok: true, canonicalPath, retainedLeaf }
  if (navigation && entryPinned && looksLikeRoute(url.pathname)) return { ok: true, canonicalPath: entryPath }
  return { ok: false, reason: canonicalPath === null ? 'not a valid canonical asset path' : 'not in the pinned asset set' }
}
