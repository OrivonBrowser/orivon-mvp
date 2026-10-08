// The two reads a first visit to a published app is made of (ADR-0074): the manifest alone, so the
// person is asked before any file is downloaded, and then the whole bundle, held in staging until
// the caller decides whether to install it. Nothing here pins, registers or serves: that is
// `Loader.installFetched`, which the caller runs once it has judged the files.

import type { Manifest } from '../contracts/index.js'
import type { BundleTree } from '../broker/policy/bundle-hash.js'
import { MANIFEST_PATH } from '../broker/policy/canonical-path.js'
import { originFromUrl } from '../broker/policy/origin.js'
import type { ContentAddress } from '../broker/policy/pin.js'
import type { DdocDeclaration } from './ddoc-declaration.js'
import { fetchBundle } from './fetch/bundle.js'
import type { StagedAsset } from './fetch/bundle.js'
import { pinnedToRoot } from './fetch/content-root.js'
import { fetchManifestAtRoot } from './fetch/manifest-at-root.js'
import type { ManifestAtRoot } from './fetch/manifest-at-root.js'
import type { CreateLoaderOptions } from './index.js'
import { leafOf } from './leaf-hash.js'
import type { LoadRejected } from './load-result.js'

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
  /** `transient`: the download failed in a way that may pass (a gateway's 502, a dropped connection, a manifest that moved meanwhile) after its attempts; otherwise the bundle itself is bad. */
  | { readonly ok: false, readonly reason: string, readonly transient?: true }

export interface FirstVisitApi {
  /** The manifest of the app at `hintedUrl`'s origin and nothing else of its files. Never throws. */
  readManifest(hintedUrl: string): Promise<FirstManifest>
  /**
   * Downloads every file of the app `read` described, from the same root, into staging. Nothing is
   * pinned, registered or served. Fails when a file cannot be downloaded, and when the manifest it
   * received is not the one `read` holds.
   */
  fetchForInstall(read: FirstManifestApp, hintedUrl: string): Promise<FirstBundle>
}

type ContentOf = (origin: string | null) => Promise<ContentAddress | undefined | LoadRejected>

export function createFirstVisit (
  options: CreateLoaderOptions,
  contentOf: ContentOf,
  manifestAt: (origin: string, cid: string) => Promise<ManifestAtRoot>
): FirstVisitApi {
  async function readManifest (hintedUrl: string): Promise<FirstManifest> {
    const origin = originFromUrl(hintedUrl)
    if (origin === null) return { kind: 'unread', reason: `not a valid app origin: ${hintedUrl}` }
    const content = await contentOf(origin)
    if (content !== undefined && 'outcome' in content) return { kind: 'unread', reason: content.reason }
    const read = content === undefined
      ? await fetchManifestAtRoot(options.fetch, options.resolve, origin, undefined)
      : await manifestAt(origin, content.cid)
    if (read.kind !== 'app') return read
    return { kind: 'app', canonicalOrigin: origin, manifest: read.manifest, bytes: read.bytes, content }
  }

  async function fetchForInstall (read: FirstManifestApp, hintedUrl: string): Promise<FirstBundle> {
    const fetched = await fetchBundle(pinnedToRoot(options.fetch, read.content?.cid), hintedUrl, options.resolve, options.storage)
    if (!fetched.ok) return { ok: false, reason: fetched.reason, ...('transient' in fetched && fetched.transient === true ? { transient: true as const } : {}) }
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

  return { readManifest, fetchForInstall }
}
