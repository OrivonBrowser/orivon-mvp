// Fetches a manifest and its declared assets, and turns them into a hashed,
// entry-checked BundleTree: (fetch, hintedUrl) in, a validated bundle out.
// The asset list is never supplied by a caller -- it is read off the
// manifest itself (manifest.entry unioned with manifest.assets, ADR-0011)
// once this file has fetched and parsed it, since the passive discovery
// trigger this exists for (README.md) never has anything but hintedUrl to
// start from. Every byte goes to the origin's staging area as it arrives
// and is hashed from there (fetch-asset.ts): nothing is held whole in
// memory. The site's own published hash tree (ddoc-declaration.ts) is
// fetched too and handed on beside the computed tree, never compared here:
// it decides nothing about whether the bundle loads. TOFU vs.
// decideUpdate() branching and persistence are index.ts's job, not this
// file's -- why this file exists on its own: README.md, Design notes.

import type { Manifest } from '../contracts/index.js'
import { MAX_ASSET_BYTES, MAX_BUNDLE_BYTES, bundleTreeFromLeaves } from '../broker/policy/bundle-hash.js'
import type { BundleTree } from '../broker/policy/bundle-hash.js'
import { MANIFEST_PATH, MAX_BUNDLE_ENTRIES, canonicalAssetPath } from '../broker/policy/canonical-path.js'
import type { Resolver } from '../broker/policy/connect.js'
import { originFromUrl } from '../broker/policy/origin.js'
import { ensurePublicUnicastOrigin } from './install-origin.js'
import type { InstallOriginResult } from './install-origin.js'
import { isOrivonErrorLike } from '../broker/errors.js'
import { MAX_MANIFEST_BYTES, describeValue, parseManifest } from './manifest.js'
import { BUNDLE_TIMEOUT_MS, ByteBudget, NOT_MODIFIED, fetchWithBudget, joinChunks, raceAbort, rejected } from './fetch-budget.js'
import type { Fetch, FetchBundleRejected } from './fetch-budget.js'
import { FETCH_CONCURRENCY, fetchAssetToStaging, forEachBounded, resolveUrl, stageBytes } from './fetch-asset.js'
import type { StagedAsset } from './fetch-asset.js'
import { fetchDdocDeclaration } from './ddoc-declaration.js'
import type { DdocDeclaration } from './ddoc-declaration.js'
import type { LoaderStorage } from './storage.js'
import { conditionalHeaders, validatorsFrom } from './update-check.js'
import type { ManifestValidators } from './update-check.js'

export type { Fetch, FetchResponse } from './fetch-budget.js'
export type { StagedAsset } from './fetch-asset.js'
export { BUNDLE_TIMEOUT_MS, FETCH_IDLE_TIMEOUT_MS } from './fetch-budget.js'

export interface FetchBundleOk {
  readonly ok: true
  readonly canonicalOrigin: string
  readonly manifest: Manifest
  readonly tree: BundleTree
  /** Every leaf, manifest included, waiting in the origin's staging area -- see StagedAsset. */
  readonly entries: readonly StagedAsset[]
  /** The manifest response's validators, for the next check to be conditional on. */
  readonly validators?: ManifestValidators
  /** What the site publishes at DDOC_PATH, `undefined` when it publishes nothing readable. Never checked against `tree` here. */
  readonly declaration: DdocDeclaration | undefined
}

/**
 * The host answered a conditional manifest request with 304: nothing was
 * downloaded. `ok: false`, so a caller that does not look for
 * `notModified` treats it as a failed fetch, never as a bundle.
 */
export interface FetchBundleNotModified {
  readonly ok: false
  readonly notModified: true
  readonly reason: string
}

export type { FetchBundleRejected } from './fetch-budget.js'
export type FetchBundleResult = FetchBundleOk | FetchBundleRejected | FetchBundleNotModified

/** The byte caps one fetch enforces. Injectable only so a test can exercise them without hundreds of MiB of fixture. */
export interface FetchLimits {
  readonly assetBytes: number
  readonly bundleBytes: number
}

const DEFAULT_LIMITS: FetchLimits = { assetBytes: MAX_ASSET_BYTES, bundleBytes: MAX_BUNDLE_BYTES }

/**
 * Resolves the app's entry point to the canonical path bundleTree()'s
 * output must be checked against -- exact-string against `tree.assets`,
 * never a second, looser notion of "matches". Guarded via resolveUrl:
 * validateEntry's own encoding walks `entry` one segment at a time, a
 * different algorithm from resolving the whole string here, so a string
 * that survives one is not proven to survive the other.
 *
 * Exported for serve.ts's use (Rule 3): it needs this identical
 * `manifest.entry` -> canonical-path resolution to decide what a request
 * for `/` serves.
 */
export function entryCanonicalPath (canonicalOrigin: string, entry: string): string | null {
  const resolved = resolveUrl(entry, `${canonicalOrigin}/`)
  return resolved === null ? null : canonicalAssetPath(resolved)
}

/** Fetches the manifest into memory (it is bounded by MAX_MANIFEST_BYTES) and stages it like any other leaf. */
async function fetchManifest (
  fetchFn: Fetch,
  canonicalOrigin: string,
  pinnedAddresses: readonly string[],
  storage: LoaderStorage,
  budget: ByteBudget,
  bundleSignal: AbortSignal,
  validators: ManifestValidators | undefined
): Promise<{ readonly manifest: Manifest, readonly staged: StagedAsset, readonly validators: ManifestValidators | undefined } | FetchBundleRejected | FetchBundleNotModified> {
  // Always exactly `<origin>${MANIFEST_PATH}` (capability-api.md "How a URL
  // becomes an app"), never a path component of `hintedUrl`: bundleTree()
  // rejects any bundle with no leaf at that literal path anyway.
  const manifestUrl = `${canonicalOrigin}${MANIFEST_PATH}`
  const chunks: Uint8Array[] = []
  const fetched = await fetchWithBudget(fetchFn, manifestUrl, pinnedAddresses, MAX_MANIFEST_BYTES, budget, 'manifest', bundleSignal,
    async (chunk) => { chunks.push(chunk) }, validators === undefined ? undefined : conditionalHeaders(validators))
  if ('ok' in fetched) return fetched
  if (validators !== undefined && fetched.response.status === NOT_MODIFIED) {
    return { ok: false, notModified: true, reason: `the manifest for ${canonicalOrigin} is unchanged since the last check` }
  }

  const bytes = joinChunks(chunks, fetched.byteLength)

  const parsed = parseManifest(new TextDecoder('utf-8', { fatal: false }).decode(bytes))
  if (!parsed.ok) return rejected(parsed.reason)
  warnIgnoredFields(canonicalOrigin, parsed.ignoredFields)
  try {
    const staged = await stageBytes(storage, canonicalOrigin, MANIFEST_PATH, bytes)
    return { manifest: parsed.manifest, staged, validators: validatorsFrom(fetched.response) }
  } catch (error) {
    console.error('[loader] could not stage the manifest', canonicalOrigin, error)
    return rejected(`the manifest for ${canonicalOrigin} could not be written to local storage`)
  }
}

const MAX_NAMED_IGNORED_FIELDS = 20

function warnIgnoredFields (canonicalOrigin: string, ignored: readonly string[]): void {
  if (ignored.length === 0) return
  const named = ignored.slice(0, MAX_NAMED_IGNORED_FIELDS).map(describeValue).join(', ')
  const more = ignored.length > MAX_NAMED_IGNORED_FIELDS ? `, and ${String(ignored.length - MAX_NAMED_IGNORED_FIELDS)} more` : ''
  console.warn(`[loader] ${canonicalOrigin}'s manifest has top-level field(s) this version of Orivon does not recognise; ignored: ${named}${more}`)
}

/**
 * `hintedUrl` is all a passive discovery trigger ever has -- the asset list
 * is read off the manifest itself, once it is fetched below, never supplied
 * by a caller. See README.md, Design notes.
 *
 * Empties `origin`'s staging area first; on success the staged entries are
 * the caller's (index.ts installs or discards them), on any rejection they
 * are cleared again here.
 *
 * `validators` (update-check.ts) makes the manifest request conditional; a
 * 304 then ends the fetch as `notModified`, before any asset is requested.
 */
export async function fetchBundle (
  fetchFn: Fetch,
  hintedUrl: string,
  resolveFn: Resolver,
  storage: LoaderStorage,
  limits: FetchLimits = DEFAULT_LIMITS,
  validators?: ManifestValidators
): Promise<FetchBundleResult> {
  const canonicalOrigin = originFromUrl(hintedUrl)
  if (canonicalOrigin === null) return rejected(`hintedUrl is not a valid app origin: ${hintedUrl}`)

  // BUNDLE_TIMEOUT_MS's one clock for the WHOLE operation, started BEFORE
  // the install-origin guard's own `await`: `resolveFn` carries no timeout
  // of its own, so a guard call outside this window could hang forever
  // against a stalling nameserver. Also aborted by the first failing asset,
  // so its siblings stop instead of downloading for nothing.
  const bundleController = new AbortController()
  const bundleTimer = setTimeout(() => { bundleController.abort() }, BUNDLE_TIMEOUT_MS)
  let result: FetchBundleResult | undefined
  try {
    result = await fetchStaged(fetchFn, canonicalOrigin, resolveFn, storage, limits, bundleController, validators)
    return result
  } finally {
    clearTimeout(bundleTimer)
    if (result === undefined || !result.ok) {
      await storage.clearStaging(canonicalOrigin).catch((error: unknown) => {
        console.error('[loader] could not clear a failed fetch\'s staging area', canonicalOrigin, error)
      })
    }
  }
}

async function fetchStaged (
  fetchFn: Fetch,
  canonicalOrigin: string,
  resolveFn: Resolver,
  storage: LoaderStorage,
  limits: FetchLimits,
  bundleController: AbortController,
  validators: ManifestValidators | undefined
): Promise<FetchBundleResult> {
  // T12/A46, install-origin.ts -- checked before any network request below.
  // raceAbort gives up waiting once the deadline fires; it cannot force an
  // uncooperative `resolveFn` to stop (its own doc, A52).
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

  try {
    await storage.clearStaging(canonicalOrigin)
  } catch (error) {
    console.error('[loader] could not clear the staging area', canonicalOrigin, error)
    return rejected(`the bundle for ${canonicalOrigin} could not be written to local storage`)
  }

  // The ONLY resolution this install performs: every fetch below gets these
  // SAME validated literals, never a fresh, unguarded re-resolution.
  const pinnedAddresses = originResult.addresses
  const budget = new ByteBudget(limits.bundleBytes)
  const fetchedManifest = await fetchManifest(fetchFn, canonicalOrigin, pinnedAddresses, storage, budget, bundleController.signal, validators)
  if ('ok' in fetchedManifest) return fetchedManifest
  const { manifest } = fetchedManifest

  // ADR-0011: the manifest declares its own files; `entry` is unioned in as
  // a leaf like any other. manifest.ts's MAX_ASSETS already guarantees this
  // fits; kept so a bug there cannot become an oversized fetch loop here.
  const assetPaths = [manifest.entry, ...(manifest.assets ?? [])]
  if (assetPaths.length + 1 > MAX_BUNDLE_ENTRIES) {
    return rejected(`bundle would have ${String(assetPaths.length + 1)} entries, more than MAX_BUNDLE_ENTRIES (${String(MAX_BUNDLE_ENTRIES)})`)
  }

  const declaration = await fetchDdocDeclaration(fetchFn, canonicalOrigin, pinnedAddresses, budget, bundleController.signal)

  const context = { fetchFn, canonicalOrigin, pinnedAddresses, storage, budget, assetCap: limits.assetBytes, bundleSignal: bundleController.signal }
  const assets = await forEachBounded(assetPaths, FETCH_CONCURRENCY, async (path) => await fetchAssetToStaging(context, path), () => { bundleController.abort() })
  if (!Array.isArray(assets)) return assets
  const entries = [fetchedManifest.staged, ...assets]

  let tree: BundleTree
  try {
    tree = await bundleTreeFromLeaves(entries)
  } catch (error) {
    if (isOrivonErrorLike(error)) return rejected(error.message)
    throw error // a bug in this file or bundle-hash.ts, not an untrusted-input outcome -- never swallowed
  }

  const entryPath = entryCanonicalPath(canonicalOrigin, manifest.entry)
  if (entryPath === null || !tree.assets.some((asset) => asset.path === entryPath)) {
    return rejected(`bundle has no leaf at the manifest's declared entry point: ${manifest.entry}`)
  }

  return { ok: true, canonicalOrigin, manifest, tree, entries, declaration, ...(fetchedManifest.validators !== undefined && { validators: fetchedManifest.validators }) }
}
