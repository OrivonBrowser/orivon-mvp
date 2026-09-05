// Fetches a manifest and its declared assets, and turns them into a hashed,
// entry-checked BundleTree: (fetch, hintedUrl) in, a validated bundle out.
// The asset list is never supplied by a caller -- it is read off the
// manifest itself (manifest.entry unioned with manifest.assets, ADR-0011)
// once this file has fetched and parsed it, since the passive discovery
// trigger this exists for (README.md) never has anything but hintedUrl to
// start from. TOFU vs. decideUpdate() branching and persistence are
// index.ts's job, not this file's -- why this file exists on its own:
// README.md, Design notes.

import type { Manifest } from '../contracts/index.js'
import { MAX_ASSET_BYTES, MAX_BUNDLE_BYTES, bundleTree } from '../broker/policy/bundle-hash.js'
import type { BundleEntry, BundleTree } from '../broker/policy/bundle-hash.js'
import { MANIFEST_PATH, MAX_BUNDLE_ENTRIES, canonicalAssetPath } from '../broker/policy/canonical-path.js'
import type { Resolver } from '../broker/policy/connect.js'
import { originFromUrl } from '../broker/policy/origin.js'
import { ensurePublicUnicastOrigin } from './install-origin.js'
import type { InstallOriginResult } from './install-origin.js'
import { isOrivonErrorLike } from '../broker/errors.js'
import { MAX_MANIFEST_BYTES, parseManifest } from './manifest.js'
import { BUNDLE_TIMEOUT_MS, fetchWithBudget, raceAbort, rejected } from './fetch-budget.js'
import type { Fetch, FetchBundleRejected, FetchResponse } from './fetch-budget.js'

export type { Fetch, FetchResponse } from './fetch-budget.js'
export { BUNDLE_TIMEOUT_MS, FETCH_TIMEOUT_MS } from './fetch-budget.js'

export interface FetchBundleOk {
  readonly ok: true
  readonly canonicalOrigin: string
  readonly manifest: Manifest
  readonly tree: BundleTree
  /** Every leaf's raw bytes, manifest included (bundle-hash.ts: "the manifest is a leaf like any other asset"). */
  readonly entries: readonly BundleEntry[]
}

export type { FetchBundleRejected } from './fetch-budget.js'
export type FetchBundleResult = FetchBundleOk | FetchBundleRejected

/**
 * `new URL(path, base)`, guarded. `URL`'s constructor throws `TypeError` on
 * a malformed `path` (confirmed live: `new URL('http://[not-valid-ipv6/x.js',
 * 'https://good.example/')`) -- this file's own header promises exactly four
 * outcomes and never a fifth, so nothing here may let that escape as an
 * uncaught exception. Both callers below resolve caller-supplied path
 * strings this way; neither may trust the input is well-formed.
 */
function resolveUrl (path: string, base: string): string | null {
  try {
    return new URL(path, base).href
  } catch {
    return null
  }
}

/**
 * Resolves the app's entry point to the canonical path bundleTree()'s
 * output must be checked against. `entry` is already known safe as a STRING
 * (manifest.ts's validateEntry ran inside parseManifest) -- this resolves it
 * against the real origin the same way an asset URL would be, so the
 * comparison below is exact-string against `tree.assets`, never a second,
 * looser notion of "matches". Guarded via resolveUrl anyway: validateEntry's
 * own encoding walks `entry` one path segment at a time, a different
 * algorithm from resolving the whole string as a relative reference here --
 * a string that survives one is not proven to survive the other.
 */
function entryCanonicalPath (canonicalOrigin: string, entry: string): string | null {
  const resolved = resolveUrl(entry, `${canonicalOrigin}/`)
  return resolved === null ? null : canonicalAssetPath(resolved)
}

/**
 * `hintedUrl` is all a passive discovery trigger ever has -- the asset list
 * is read off the manifest itself, once it is fetched below, never supplied
 * by a caller. See README.md, Design notes.
 */
export async function fetchBundle (
  fetchFn: Fetch,
  hintedUrl: string,
  resolveFn: Resolver
): Promise<FetchBundleResult> {
  const canonicalOrigin = originFromUrl(hintedUrl)
  if (canonicalOrigin === null) return rejected(`hintedUrl is not a valid app origin: ${hintedUrl}`)

  // F6: BUNDLE_TIMEOUT_MS's one clock for the WHOLE operation, including the
  // install-origin guard's own resolution below -- started here, BEFORE that
  // `await`, not after it. `resolveFn` carries no timeout of its own
  // (Resolver's own doc comment), so a guard call started outside this
  // deadline window would hang with no clock at all against a deliberately
  // stalling nameserver -- exactly the unbounded-duration T11b DoS
  // BUNDLE_TIMEOUT_MS exists to close, reopened one `await` above where it
  // used to start. `bundleController.signal` is threaded into every
  // fetchWithBudget call below; see BUNDLE_TIMEOUT_MS's and
  // fetchWithBudget's own comments for why.
  const bundleController = new AbortController()
  const bundleTimer = setTimeout(() => { bundleController.abort() }, BUNDLE_TIMEOUT_MS)
  try {
    // T12/A46, install-origin.ts -- checked before any network request
    // below, and (F6, above) already inside the bundle's own deadline.
    // raceAbort gives up waiting once the deadline fires; it cannot force an
    // uncooperative `resolveFn` to actually stop (raceAbort's own comment on
    // what it does not close), the same residual raceAbort already carries
    // for a stalling `fetchFn`.
    let originResult: InstallOriginResult
    try {
      originResult = await raceAbort(
        ensurePublicUnicastOrigin(canonicalOrigin, resolveFn),
        bundleController.signal,
        () => new Error(`resolving the install origin's host exceeded the bundle's overall deadline of ${String(BUNDLE_TIMEOUT_MS)}ms`)
      )
    } catch (error) {
      return rejected(error instanceof Error ? error.message : String(error))
    }
    if (!originResult.ok) return rejected(originResult.reason)
    // F2/F5: the ONLY resolution this whole install ever performs. Every
    // fetch below -- the manifest and every declared asset -- is handed
    // these SAME validated literals, never a fresh, unguarded re-resolution
    // of the hostname; see InstallOriginOk's and Fetch's own comments for
    // why that discipline is the fix.
    const pinnedAddresses = originResult.addresses

    let bytesUsed = 0
    // Always exactly `<origin>${MANIFEST_PATH}` (capability-api.md "How a
    // URL becomes an app"), never a path component of `hintedUrl`. Not a
    // stylistic choice: bundleTree() rejects any bundle with no leaf at that
    // literal canonical path (canonical-path.ts's MANIFEST_PATH), so a
    // manifest fetched from anywhere else could never produce an accepted
    // bundle regardless -- `hintedUrl` is used only to name which origin is
    // being installed.
    const manifestUrl = `${canonicalOrigin}${MANIFEST_PATH}`
    const manifestFetch = await fetchWithBudget(fetchFn, manifestUrl, pinnedAddresses, MAX_MANIFEST_BYTES, MAX_BUNDLE_BYTES, 'manifest', bundleController.signal)
    if ('ok' in manifestFetch) return manifestFetch
    bytesUsed += manifestFetch.content.length

    // Derived from the RESOLVED url the fetch actually returned
    // (`response.url`), never the url that was requested. Same "trust what
    // happened, not what was asked for" stance origin.ts's
    // originFromSenderFrame takes for T3 -- a redirect must not be able to
    // silently attribute these bytes to a path, or an origin, other than
    // where they actually came from. The asset loop below applies the same
    // stance to `assetFetch.response.url`.
    const manifestOrigin = originFromUrl(manifestFetch.response.url)
    if (manifestOrigin !== canonicalOrigin) {
      return rejected(`manifest was served from a different origin (${manifestOrigin ?? 'invalid'}) than requested (${canonicalOrigin})`)
    }
    const manifestCanonicalPath = canonicalAssetPath(manifestFetch.response.url)
    if (manifestCanonicalPath !== MANIFEST_PATH) {
      return rejected(`manifest was served from ${manifestCanonicalPath ?? manifestFetch.response.url}, not the well-known path ${MANIFEST_PATH}`)
    }

    const manifestText = new TextDecoder('utf-8', { fatal: false }).decode(manifestFetch.content)
    const parsed = parseManifest(manifestText)
    if (!parsed.ok) return rejected(parsed.reason)
    const manifest = parsed.manifest

    // ADR-0011: the manifest declares its own files. `entry` is unioned in
    // rather than fetched separately -- it is a leaf of the bundle like any
    // other declared asset, and the entry-leaf check below needs it present
    // in `entries` to find it there.
    const assetPaths = [manifest.entry, ...(manifest.assets ?? [])]

    // Expected unreachable, kept anyway: manifest.ts's own MAX_ASSETS cap
    // already guarantees manifest.assets.length <= MAX_BUNDLE_ENTRIES - 2 for
    // any manifest that reached this line, so assetPaths.length + 1 here can
    // never exceed MAX_BUNDLE_ENTRIES. This function must not trust that
    // invariant blindly, though -- a bug in manifest.ts's own accounting must
    // not silently turn into an oversized fetch loop here instead. It cannot
    // run any earlier: assetPaths is derived from the manifest, so there is
    // nothing to count until that one fetch has already happened. That one
    // fetch is itself bounded on its own terms (MAX_MANIFEST_BYTES, checked
    // above by fetchWithBudget), and this line still runs before the
    // per-asset loop below starts -- so an over-cap list still costs at most
    // that one fetch, never one per declared asset.
    if (assetPaths.length + 1 > MAX_BUNDLE_ENTRIES) {
      return rejected(`bundle would have ${String(assetPaths.length + 1)} entries, more than MAX_BUNDLE_ENTRIES (${String(MAX_BUNDLE_ENTRIES)})`)
    }

    const entries: BundleEntry[] = [{ path: MANIFEST_PATH, content: manifestFetch.content }]

    for (const assetPath of assetPaths) {
      const assetUrl = resolveUrl(assetPath, `${canonicalOrigin}/`)
      if (assetUrl === null) return rejected(`asset path is not a valid URL: ${assetPath}`)

      // Checked BEFORE fetchFn is ever called: `new URL(assetPath, base)`
      // honours an absolute or protocol-relative assetPath (e.g.
      // "https://attacker.example/x"), so without this an entry crafted that
      // way would trigger a real outbound request before the origin is ever
      // looked at. The post-fetch check below on the RESOLVED url still runs
      // too -- this one catches a bad request before it happens, that one
      // catches a redirect after it happens; neither replaces the other.
      const requestedOrigin = originFromUrl(assetUrl)
      if (requestedOrigin !== canonicalOrigin) {
        return rejected(`asset ${assetPath} resolves to a different origin (${requestedOrigin ?? 'invalid'}) than the app's (${canonicalOrigin})`)
      }

      // F5: the SAME `pinnedAddresses` the manifest fetch above used --
      // never a fresh resolution per asset. Without this, the up-to-
      // BUNDLE_TIMEOUT_MS (10 minute) asset loop would be exactly the
      // re-resolution window F2 closes for the manifest fetch alone, just
      // moved one loop iteration later.
      const assetFetch = await fetchWithBudget(fetchFn, assetUrl, pinnedAddresses, MAX_ASSET_BYTES, MAX_BUNDLE_BYTES - bytesUsed, `asset ${assetPath}`, bundleController.signal)
      if ('ok' in assetFetch) return assetFetch

      // Resolved url, not requested url -- same stance as the manifest
      // check above.
      const assetOrigin = originFromUrl(assetFetch.response.url)
      if (assetOrigin !== canonicalOrigin) {
        return rejected(`asset ${assetPath} was served from a different origin (${assetOrigin ?? 'invalid'}) than requested (${canonicalOrigin})`)
      }
      const canonicalPath = canonicalAssetPath(assetFetch.response.url)
      if (canonicalPath === null) return rejected(`asset ${assetPath} resolved to a URL with no canonical path: ${assetFetch.response.url}`)

      bytesUsed += assetFetch.content.length
      entries.push({ path: canonicalPath, content: assetFetch.content })
    }

    let tree: BundleTree
    try {
      tree = await bundleTree(entries)
    } catch (error) {
      if (isOrivonErrorLike(error)) return rejected(error.message)
      throw error // a bug in this file or bundle-hash.ts, not an untrusted-input outcome -- never swallowed
    }

    const entryPath = entryCanonicalPath(canonicalOrigin, manifest.entry)
    if (entryPath === null || !tree.assets.some((asset) => asset.path === entryPath)) {
      return rejected(`bundle has no leaf at the manifest's declared entry point: ${manifest.entry}`)
    }

    return { ok: true, canonicalOrigin, manifest, tree, entries }
  } finally {
    clearTimeout(bundleTimer)
  }
}
