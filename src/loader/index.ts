// The app loader's fetch-and-cache path: createLoader({fetch, storage, now})
// mirrors how src/broker/index.ts builds createBroker -- injected effects,
// no Electron import, unit-testable against stubs. This file is the
// orchestration only; fetching+hashing+entry-checking is fetch-bundle.ts,
// the Manifest.capabilities -> PatternSet mapping is update-patterns.ts, and
// the storage seam is storage.ts. See src/loader/README.md.
//
// THE FOUR OUTCOMES (this lane's acceptance criteria): `installed` (TOFU on
// first install, or a `silent` decideUpdate() verdict on refetch -- both
// mean "ready to run, nothing to ask the user"), `needs-reconsent`,
// `needs-capability-prompt`, `rejected`. Showing UI for the middle two, or
// wiring the broker's grant prompt, is explicitly out of this lane's scope
// (src/loader/README.md, this lane's brief) -- this function returns the
// verdict and stops.
//
// CRITERION 4: decideUpdate() is called with `context.grantedPatterns` --
// what the grant ledger actually holds -- NEVER `manifest.capabilities`.
// This codebase has a filed history of exactly that mistake (A18, A27).
// `context` is supplied by the caller because the grant ledger lives in
// src/broker/, which this file does not read; see LoadContext below.

import type { Manifest } from '../contracts/index.js'
import type { BundleEntry, BundleTree } from '../broker/policy/bundle-hash.js'
import { fromBundleTree, parsePinRecord } from '../broker/policy/pin.js'
import type { PinRecord } from '../broker/policy/pin.js'
import { decideUpdate } from '../broker/policy/update.js'
import type { PatternSet } from '../broker/policy/update.js'
import { fetchBundle } from './fetch-bundle.js'
import type { Fetch } from './fetch-bundle.js'
import type { LoaderStorage } from './storage.js'
import { patternSetFromCapabilities } from './update-patterns.js'

export type { Fetch, FetchResponse } from './fetch-bundle.js'
export type { LoaderStorage } from './storage.js'
export { appRootDirectoryName } from './storage.js'

export interface CreateLoaderOptions {
  readonly fetch: Fetch
  readonly storage: LoaderStorage
  /** Clock, read once per install/refetch (`PinRecord.pinnedAt`). Injected so a test can freeze it -- matches createBroker's own `now`. */
  readonly now: () => number
}

/**
 * What decideUpdate() needs that this file cannot derive on its own,
 * because it lives in the grant ledger (src/broker/), which this file does
 * not read -- see this file's header. Ignored entirely on a fresh install:
 * TOFU (ADR-0005) has no existing grant or floor to check against.
 */
export interface LoadContext {
  /** What the origin actually holds, from the grant ledger -- never the manifest's declared set. */
  readonly grantedPatterns: PatternSet
  /** The highest version ever installed for this origin (T19). `'0.0.0'` for an origin that has never been granted anything, per compareVersions' release-component semantics. */
  readonly versionFloor: string
}

export interface LoadInstalled {
  readonly outcome: 'installed'
  readonly canonicalOrigin: string
  readonly manifest: Manifest
  readonly pin: PinRecord
}

export interface LoadNeedsReconsent {
  readonly outcome: 'needs-reconsent'
  readonly canonicalOrigin: string
  readonly manifest: Manifest
  readonly tree: BundleTree
  /** Every leaf's raw bytes -- so a future caller can persist after approval without re-fetching. */
  readonly entries: readonly BundleEntry[]
}

export interface LoadNeedsCapabilityPrompt {
  readonly outcome: 'needs-capability-prompt'
  readonly canonicalOrigin: string
  readonly manifest: Manifest
  readonly tree: BundleTree
  readonly entries: readonly BundleEntry[]
  /** What the new manifest asks for -- the prompt's own job to render, not this lane's. */
  readonly requestedPatterns: PatternSet
}

export interface LoadRejected {
  readonly outcome: 'rejected'
  /** Developer-facing, same stance as fetch-bundle.ts's FetchBundleRejected. */
  readonly reason: string
}

export type LoadResult = LoadInstalled | LoadNeedsReconsent | LoadNeedsCapabilityPrompt | LoadRejected

export interface Loader {
  /**
   * `hintedUrl` names the origin to install -- from a `<link
   * rel="orivon-manifest">` hint already in delivered HTML, the only
   * discovery trigger (src/loader/README.md; never probed automatically).
   * The manifest is always fetched from exactly
   * `<that origin>/.well-known/orivon.json` -- see fetch-bundle.ts's header
   * for why a path component of `hintedUrl` is never used as the manifest
   * location.
   *
   * `assetPaths` is the discovered set of the app's frontend files.
   * `Manifest` has no field naming them and nothing in the doc corpus
   * specifies a discovery mechanism -- docs/open-questions.md A45, filed
   * rather than guessed. The caller supplies what it already knows.
   */
  load(hintedUrl: string, assetPaths: readonly string[], context: LoadContext): Promise<LoadResult>
}

/** Persists a freshly accepted bundle (TOFU or a `silent` verdict) and returns the pin caller-facing code sees. */
async function install (
  storage: LoaderStorage,
  canonicalOrigin: string,
  manifest: Manifest,
  tree: BundleTree,
  entries: readonly BundleEntry[],
  now: number
): Promise<PinRecord> {
  const pin = fromBundleTree(canonicalOrigin, tree.root, tree.assets, manifest.version, now)
  for (const entry of entries) {
    await storage.writeAsset(canonicalOrigin, entry.path, entry.content)
  }
  await storage.writePin(canonicalOrigin, pin)
  return pin
}

export function createLoader (options: CreateLoaderOptions): Loader {
  async function load (hintedUrl: string, assetPaths: readonly string[], context: LoadContext): Promise<LoadResult> {
    const fetched = await fetchBundle(options.fetch, hintedUrl, assetPaths)
    if (!fetched.ok) return { outcome: 'rejected', reason: fetched.reason }
    const { canonicalOrigin, manifest, tree, entries } = fetched

    const rawPin = await options.storage.readPin(canonicalOrigin)
    if (rawPin === undefined) {
      // TOFU (ADR-0005): nothing was ever pinned for this origin, so there
      // is no continuity to protect and nothing to prompt for.
      const pin = await install(options.storage, canonicalOrigin, manifest, tree, entries, options.now())
      return { outcome: 'installed', canonicalOrigin, manifest, pin }
    }

    // A pin record exists but fails to parse (corrupt bytes, a schema this
    // broker no longer recognises) is NOT the same as never having existed --
    // treating it as fresh TOFU would let local corruption (or tampering)
    // silently re-install without a prompt. An empty `pinnedHash` routes
    // through decideUpdate's own "blank counts as changed" rule
    // (update.ts's isSameBundle), which can never resolve weaker than
    // `reconsent` -- it still goes through the version-floor and
    // pattern-widening checks first, exactly like a real hash change would.
    const existingPin = parsePinRecord(rawPin)
    const pinnedHash = existingPin?.bundleHash ?? ''

    const decision = decideUpdate({
      pinnedHash,
      newHash: tree.root,
      grantedPatterns: context.grantedPatterns,
      newPatterns: patternSetFromCapabilities(manifest.capabilities),
      version: manifest.version,
      versionFloor: context.versionFloor
    })

    switch (decision) {
      case 'reject':
        return { outcome: 'rejected', reason: `${manifest.version} is below this origin's version floor (${context.versionFloor})` }
      case 'capability-prompt':
        return {
          outcome: 'needs-capability-prompt',
          canonicalOrigin,
          manifest,
          tree,
          entries,
          requestedPatterns: patternSetFromCapabilities(manifest.capabilities)
        }
      case 'reconsent':
        return { outcome: 'needs-reconsent', canonicalOrigin, manifest, tree, entries }
      case 'silent': {
        const pin = await install(options.storage, canonicalOrigin, manifest, tree, entries, options.now())
        return { outcome: 'installed', canonicalOrigin, manifest, pin }
      }
    }
  }

  return { load }
}
