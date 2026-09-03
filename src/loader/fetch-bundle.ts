// Fetches a manifest and its declared assets, and turns them into a hashed,
// entry-checked BundleTree. Split out of index.ts (docs/development/
// code-guidelines.md Rule 2) -- this file owns exactly one concern: turning
// (fetch, hintedUrl, assetPaths) into a validated bundle. TOFU vs.
// decideUpdate() branching and persistence are index.ts's job, not this
// file's.
//
// THE ASSET LIST IS AN EXPLICIT PARAMETER, not discovered from the manifest.
// `Manifest` (src/contracts/manifest.ts) has no field naming an app's
// frontend files -- only `entry`, one HTML file -- and nothing in the doc
// corpus specifies a discovery/crawl mechanism. Filed as
// docs/open-questions.md A44 rather than guessed. Everything downstream of
// "here is the asset URL set" is fully real below.
//
// THE MANIFEST IS ALWAYS FETCHED FROM EXACTLY `<origin>/.well-known/
// orivon.json` (capability-api.md SSHow a URL becomes an app), never from a
// path component of `hintedUrl`. This is not a stylistic choice: bundleTree()
// rejects any bundle with no leaf at that literal canonical path
// (canonical-path.ts's MANIFEST_PATH), so a manifest fetched from anywhere
// else could never produce an accepted bundle regardless. `hintedUrl` is
// used only to name which ORIGIN is being installed.
//
// EVERY CANONICAL PATH IS DERIVED FROM THE ACTUAL FETCH RESPONSE'S RESOLVED
// URL (`response.url`), never the URL that was requested. Same "trust what
// happened, not what was asked for" stance origin.ts's originFromSenderFrame
// takes for T3 -- a redirect must not be able to silently attribute an
// asset's bytes to a path, or an origin, other than where they actually came
// from.

import type { Manifest } from '../contracts/index.js'
import { MAX_ASSET_BYTES, MAX_BUNDLE_BYTES, bundleTree } from '../broker/policy/bundle-hash.js'
import type { BundleEntry, BundleTree } from '../broker/policy/bundle-hash.js'
import { MANIFEST_PATH, MAX_BUNDLE_ENTRIES, canonicalAssetPath } from '../broker/policy/canonical-path.js'
import { originFromUrl } from '../broker/policy/origin.js'
import { isOrivonErrorLike } from '../broker/errors.js'
import { MAX_MANIFEST_BYTES, parseManifest } from './manifest.js'

/**
 * Structurally typed against the real global `fetch`'s `Response` (which
 * satisfies this shape as-is) so tests can stub it trivially, the same way
 * src/broker/policy/connect.ts's `Resolver` and src/broker/index.ts's `Dial`
 * are minimal structural types rather than the full web API.
 */
export interface FetchResponse {
  readonly ok: boolean
  readonly status: number
  /** The RESOLVED url, after any redirect -- see this file's header. */
  readonly url: string
  /**
   * Optional: not every caller can supply headers, and their absence never
   * weakens the caps below -- only removes the fail-fast-before-download
   * optimisation that reading one provides.
   */
  readonly headers?: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
}

export type Fetch = (url: string) => Promise<FetchResponse>

export interface FetchBundleOk {
  readonly ok: true
  readonly canonicalOrigin: string
  readonly manifest: Manifest
  readonly tree: BundleTree
  /** Every leaf's raw bytes, manifest included (bundle-hash.ts: "the manifest is a leaf like any other asset"). */
  readonly entries: readonly BundleEntry[]
}

export interface FetchBundleRejected {
  readonly ok: false
  /** Developer-facing, same stance as manifest.ts's own ManifestRejected -- never shown to an end user as-is. */
  readonly reason: string
}

export type FetchBundleResult = FetchBundleOk | FetchBundleRejected

function rejected (reason: string): FetchBundleRejected {
  return { ok: false, reason }
}

/** `Content-Length`, if present and a valid non-negative integer. Never trusted alone -- see checkBudget. */
function declaredLength (response: FetchResponse): number | undefined {
  const raw = response.headers?.get('content-length') ?? response.headers?.get('Content-Length')
  if (raw === null || raw === undefined) return undefined
  if (!/^[0-9]+$/.test(raw)) return undefined
  return Number(raw)
}

/**
 * One fetch, with the byte caps applied on both sides of the download: the
 * DECLARED length (Content-Length), when the server sent one, is checked
 * BEFORE the body is read -- so an oversized response can be rejected
 * without ever downloading it. The ACTUAL length is checked again after,
 * because a declared length is advisory and may be absent, wrong, or a lie.
 * Both checks are against the same two numbers: this one asset's own cap
 * (`assetCap`) and how much room is left in the whole bundle (`remaining`).
 */
async function fetchWithBudget (
  fetchFn: Fetch,
  url: string,
  assetCap: number,
  remaining: number,
  label: string
): Promise<{ readonly response: FetchResponse, readonly content: Uint8Array } | FetchBundleRejected> {
  let response: FetchResponse
  try {
    response = await fetchFn(url)
  } catch (error) {
    return rejected(`could not fetch ${label} (${url}): ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) return rejected(`${label} fetch failed: HTTP ${String(response.status)} (${url})`)

  const declared = declaredLength(response)
  if (declared !== undefined) {
    if (declared > assetCap) return rejected(`${label} declares ${String(declared)} bytes, over its cap of ${String(assetCap)}: ${url}`)
    if (declared > remaining) return rejected(`${label} declares ${String(declared)} bytes, more than fits in the bundle's remaining budget: ${url}`)
  }

  const buffer = await response.arrayBuffer()
  const content = new Uint8Array(buffer)
  if (content.length > assetCap) return rejected(`${label} exceeds its cap of ${String(assetCap)} bytes (MAX_ASSET_BYTES): ${url}`)
  if (content.length > remaining) return rejected(`${label} does not fit in the bundle's remaining byte budget (MAX_BUNDLE_BYTES): ${url}`)

  return { response, content }
}

/**
 * Resolves the app's entry point to the canonical path bundleTree()'s
 * output must be checked against. `entry` is already known safe as a STRING
 * (manifest.ts's validateEntry ran inside parseManifest) -- this resolves it
 * against the real origin the same way an asset URL would be, so the
 * comparison below is exact-string against `tree.assets`, never a second,
 * looser notion of "matches".
 */
function entryCanonicalPath (canonicalOrigin: string, entry: string): string | null {
  return canonicalAssetPath(new URL(entry, `${canonicalOrigin}/`).href)
}

export async function fetchBundle (
  fetchFn: Fetch,
  hintedUrl: string,
  assetPaths: readonly string[]
): Promise<FetchBundleResult> {
  const canonicalOrigin = originFromUrl(hintedUrl)
  if (canonicalOrigin === null) return rejected(`hintedUrl is not a valid app origin: ${hintedUrl}`)

  // Cheap and exact -- checked before any network call, per this lane's
  // acceptance criteria ("fail before exceeding them, not after").
  if (assetPaths.length + 1 > MAX_BUNDLE_ENTRIES) {
    return rejected(`bundle would have ${String(assetPaths.length + 1)} entries, more than MAX_BUNDLE_ENTRIES (${String(MAX_BUNDLE_ENTRIES)})`)
  }

  let bytesUsed = 0
  const manifestUrl = `${canonicalOrigin}${MANIFEST_PATH}`
  const manifestFetch = await fetchWithBudget(fetchFn, manifestUrl, MAX_MANIFEST_BYTES, MAX_BUNDLE_BYTES, 'manifest')
  if ('ok' in manifestFetch) return manifestFetch
  bytesUsed += manifestFetch.content.length

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

  const entries: BundleEntry[] = [{ path: MANIFEST_PATH, content: manifestFetch.content }]

  for (const assetPath of assetPaths) {
    const assetUrl = new URL(assetPath, `${canonicalOrigin}/`).href
    const assetFetch = await fetchWithBudget(fetchFn, assetUrl, MAX_ASSET_BYTES, MAX_BUNDLE_BYTES - bytesUsed, `asset ${assetPath}`)
    if ('ok' in assetFetch) return assetFetch

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
}
