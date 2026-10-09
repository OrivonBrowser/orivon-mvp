// The two reads a first visit to a published app is made of (ADR-0074): the manifest alone, so the
// person is asked before any file is downloaded, and then the whole bundle, held in staging until
// the caller decides whether to install it. Nothing here pins, registers or serves: that is
// `Loader.installFetched`, which the caller runs once it has judged the files.

import type { Manifest } from '../contracts/index.js'
import type { BundleTree } from '../broker/policy/bundle-hash.js'
import { MAX_ASSET_BYTES, MAX_BUNDLE_BYTES } from '../broker/policy/bundle-hash.js'
import { MANIFEST_PATH } from '../broker/policy/canonical-path.js'
import { originFromUrl } from '../broker/policy/origin.js'
import type { ContentAddress } from '../broker/policy/pin.js'
import { MAX_DDOC_BYTES, fetchDdocDeclaration } from './ddoc-declaration.js'
import type { DdocDeclaration } from './ddoc-declaration.js'
import { fetchBundle } from './fetch/bundle.js'
import { BUNDLE_TIMEOUT_MS, ByteBudget } from './fetch/budget.js'
import type { FetchBundleRejected } from './fetch/budget.js'
import { ensurePublicUnicastOrigin } from './fetch/install-origin.js'
import { RETRY_BACKOFF_MS, retryTransient } from './fetch/retry.js'
import type { StagedAsset } from './fetch/bundle.js'
import { pinnedToRoot } from './fetch/content-root.js'
import { fetchManifestAtRoot } from './fetch/manifest-at-root.js'
import type { ManifestAtRoot } from './fetch/manifest-at-root.js'
import type { CreateLoaderOptions } from './index.js'
import { leafOf } from './leaf-hash.js'
import type { LoadRejected } from './load-result.js'
import type { LiveBundle } from './serve/live-serve.js'

interface InstallOriginRefusal { readonly ok: false, readonly reason: string }

/** What the manifest of a first visit says. `website`: the content was proven to have none. `unread`: the read failed, which proves nothing. */
export type FirstManifest =
  | {
    readonly kind: 'app'
    readonly canonicalOrigin: string
    readonly manifest: Manifest
    /** The manifest as received, so the bundle fetched later can be checked to carry the same one. */
    readonly bytes: Uint8Array
    /** The root the name led to when the manifest was read, and the root the bundle is then fetched from. */
    readonly content: ContentAddress | undefined
  }
  | { readonly kind: 'website' }
  | { readonly kind: 'unread', readonly reason: string }

export type FirstManifestApp = Extract<FirstManifest, { kind: 'app' }>

export type FirstBundle =
  | {
    readonly ok: true
    readonly canonicalOrigin: string
    readonly manifest: Manifest
    readonly tree: BundleTree
    readonly entries: readonly StagedAsset[]
    /** What the site publishes as its own hash tree, or `undefined` when it publishes nothing readable. */
    readonly declaration: DdocDeclaration | undefined
    readonly content: ContentAddress | undefined
    /** Empties the staging area when the bundle is not going to be installed. */
    readonly discard: () => Promise<void>
  }
  /**
   * `transient`: the download failed in a way that may pass (a gateway's 502, a dropped connection, a manifest that
   * moved meanwhile) after its attempts. `tooLarge`: a file or the bundle is over a cap. `integrity`: the verifier
   * proved the content is not what its address names. Any other failure is simply a download that did not finish.
   */
  | { readonly ok: false, readonly reason: string, readonly transient?: true, readonly tooLarge?: true, readonly integrity?: true }

/**
 * What a site's declared tree (`/.well-known/orivon-ddoc.json`) gives a first visit to check files against.
 * `none`: the site publishes nothing readable, so its files are let in on Orivon's own checks alone. `mismatch`:
 * the tree gives the manifest the person was asked about another leaf, or none. `failed`: it could not be read,
 * which is no leave to skip the check (`integrity`: the verifier proved the content is not what its address names).
 */
export type FirstDeclaration =
  | { readonly kind: 'declared', readonly declaration: DdocDeclaration }
  | { readonly kind: 'none' }
  | { readonly kind: 'mismatch', readonly differing: readonly string[] }
  | { readonly kind: 'failed', readonly reason: string, readonly integrity?: true }

export interface FirstVisitApi {
  /**
   * The tree the site declares for the app `read` described, read from the same root and with the same retries a
   * download gets, and compared with the manifest bytes already in hand. Reads that file and no other. Never throws.
   */
  readDeclaration(read: FirstManifestApp, signal?: AbortSignal): Promise<FirstDeclaration>
  /**
   * Has the origin's own partition answer for it from the verifier, so a tab opened on it before its files are
   * pinned runs as the app, every file checked against `declaration` as it is served. `false`: this run has no
   * way to (nothing was set up). `onBadData` is called once, when a file turns out not to be what was declared.
   */
  serveLive(read: FirstManifestApp, declaration: DdocDeclaration | undefined, onBadData: LiveBundle['onBadData']): Promise<boolean>
  /** Ends what `serveLive` set up for an origin whose files turned out bad; a no-op for one served from its pin. */
  endLive(origin: string): Promise<void>
  /**
   * The manifest of the app at `hintedUrl`'s origin and nothing else of its files. Never throws. `boundMs`
   * stops waiting for an answer after that long and reads as `unread`; the read itself goes on and keeps what
   * it learns (a verified absence is remembered per root).
   */
  readManifest(hintedUrl: string, boundMs?: number): Promise<FirstManifest>
  /**
   * Downloads every file of the app `read` described, from the same root, into staging. Nothing is
   * pinned, registered or served. Fails when a file cannot be downloaded, and when the manifest it
   * received is not the one `read` holds.
   */
  fetchForInstall(read: FirstManifestApp, hintedUrl: string, signal?: AbortSignal): Promise<FirstBundle>
}

/** `read`, or an `unread` once `ms` have passed; the read is left running. */
async function withinBound (read: Promise<ManifestAtRoot>, ms: number): Promise<ManifestAtRoot> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<ManifestAtRoot>((resolve) => { timer = setTimeout(() => { resolve({ kind: 'unread', reason: `the manifest was not read within ${String(ms / 1000)} s` }) }, ms) })
  try {
    return await Promise.race([read, late])
  } finally {
    clearTimeout(timer)
  }
}

type ContentOf = (origin: string | null) => Promise<ContentAddress | undefined | LoadRejected>

export function createFirstVisit (
  options: CreateLoaderOptions,
  contentOf: ContentOf,
  manifestAt: (origin: string, cid: string) => Promise<ManifestAtRoot>
): FirstVisitApi {
  async function readManifest (hintedUrl: string, boundMs?: number): Promise<FirstManifest> {
    const origin = originFromUrl(hintedUrl)
    if (origin === null) return { kind: 'unread', reason: `not a valid app origin: ${hintedUrl}` }
    const content = await contentOf(origin)
    if (content !== undefined && 'outcome' in content) return { kind: 'unread', reason: content.reason }
    const asked = content === undefined
      ? fetchManifestAtRoot(options.fetch, options.resolve, origin, undefined)
      : manifestAt(origin, content.cid)
    const read = boundMs === undefined ? await asked : await withinBound(asked, boundMs)
    if (read.kind !== 'app') return read
    return { kind: 'app', canonicalOrigin: origin, manifest: read.manifest, bytes: read.bytes, content }
  }

  async function fetchForInstall (read: FirstManifestApp, hintedUrl: string, signal?: AbortSignal): Promise<FirstBundle> {
    const limits = { assetBytes: MAX_ASSET_BYTES, bundleBytes: MAX_BUNDLE_BYTES, strictDeclaration: true, ...(signal === undefined ? {} : { signal }) }
    const fetched = await fetchBundle(pinnedToRoot(options.fetch, read.content?.cid), hintedUrl, options.resolve, options.storage, limits)
    if (!fetched.ok) {
      const kind: Partial<Pick<FetchBundleRejected, 'transient' | 'tooLarge' | 'integrity'>> = 'notModified' in fetched ? {} : fetched
      return { ok: false, reason: fetched.reason, ...(kind.transient === true ? { transient: true as const } : {}), ...(kind.tooLarge === true ? { tooLarge: true as const } : {}), ...(kind.integrity === true ? { integrity: true as const } : {}) }
    }
    const discard = async (): Promise<void> => {
      await options.storage.clearStaging(fetched.canonicalOrigin).catch((error: unknown) => {
        console.error('[loader] could not clear a discarded bundle\'s staging area', fetched.canonicalOrigin, error)
      })
    }
    const shown = await leafOf(MANIFEST_PATH, read.bytes.length, [read.bytes])
    if (fetched.tree.assets.find((asset) => asset.path === MANIFEST_PATH)?.leaf !== shown) {
      await discard()
      return { ok: false, reason: `${fetched.canonicalOrigin}'s manifest changed while the app was being downloaded`, transient: true }
    }
    return { ok: true, canonicalOrigin: fetched.canonicalOrigin, manifest: fetched.manifest, tree: fetched.tree, entries: fetched.entries, declaration: fetched.declaration, content: read.content, discard }
  }

  async function readDeclaration (read: FirstManifestApp, signal?: AbortSignal): Promise<FirstDeclaration> {
    const origin = read.canonicalOrigin
    const guard = await ensurePublicUnicastOrigin(origin, options.resolve).catch((error: unknown): InstallOriginRefusal => ({ ok: false, reason: error instanceof Error ? error.message : String(error) }))
    if (!guard.ok) return { kind: 'failed', reason: guard.reason }
    const controller = new AbortController()
    const forwardLeft = (): void => { controller.abort() }
    if (signal?.aborted === true) controller.abort()
    signal?.addEventListener('abort', forwardLeft, { once: true })
    const timer = setTimeout(() => { controller.abort() }, BUNDLE_TIMEOUT_MS)
    try {
      const fetchFn = pinnedToRoot(options.fetch, read.content?.cid)
      const fetched = await retryTransient(async () => await fetchDdocDeclaration(fetchFn, origin, guard.addresses, new ByteBudget(MAX_DDOC_BYTES), controller.signal, true), RETRY_BACKOFF_MS, controller.signal)
      if (fetched !== undefined && 'ok' in fetched) return { kind: 'failed', reason: fetched.reason, ...(fetched.integrity === true ? { integrity: true as const } : {}) }
      if (fetched === undefined) return { kind: 'none' }
      const shown = await leafOf(MANIFEST_PATH, read.bytes.length, [read.bytes])
      if (fetched.leaves.find((entry) => entry.path === MANIFEST_PATH)?.leaf !== shown) return { kind: 'mismatch', differing: [MANIFEST_PATH] }
      return { kind: 'declared', declaration: fetched }
    } catch (error) {
      return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forwardLeft)
    }
  }

  async function serveLive (read: FirstManifestApp, declaration: DdocDeclaration | undefined, onBadData: LiveBundle['onBadData']): Promise<boolean> {
    if (options.serveLive === undefined) return false
    await options.serveLive({ origin: read.canonicalOrigin, manifest: read.manifest, declaration, content: read.content?.cid, onBadData })
    return true
  }

  async function endLive (origin: string): Promise<void> {
    await options.endLive?.(origin)
  }

  return { readManifest, fetchForInstall, readDeclaration, serveLive, endLive }
}
