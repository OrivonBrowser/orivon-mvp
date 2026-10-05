// An installed app reached at a name: what a moved name is, and how an offered update is
// fetched (ADR-0055). The ordinary path in ./index.ts downloads a whole bundle to learn what
// changed; here the new manifest alone is fetched, and the bundle only for the same files
// republished or once the person has said yes. See README.md's Design notes.

import type { BundleTree } from '../broker/policy/bundle-hash.js'
import { MANIFEST_PATH } from '../broker/policy/canonical-path.js'
import type { ContentAddress, PinRecord } from '../broker/policy/pin.js'
import type { Manifest } from '../contracts/index.js'
import type { DdocDeclaration } from './ddoc-declaration.js'
import type { CreateLoaderOptions, LoadContext } from './index.js'
import type { ManifestAtRoot } from './fetch/manifest-at-root.js'
import type { QuietOffer, UpdateOfferRecord } from './update-offer.js'
import type { LoadResult } from './load-result.js'
import { fetchBundle } from './fetch/bundle.js'
import type { StagedAsset } from './fetch/bundle.js'
import { pinnedToRoot } from './fetch/content-root.js'
import { fetchManifestAtRoot } from './fetch/manifest-at-root.js'
import { checkRecord, checkedRecently, loadCheckRecord, pinnedManifestLeaf, saveCheckRecord } from './fetch/update-check.js'
import { leafOf } from './leaf-hash.js'

/** A name is looked up at most this often per origin; in memory, so a restart checks at once. */
export const NAME_CHECK_INTERVAL_MS = 5 * 60_000

/** What the update decision in `./index.ts` is given, so this file never imports it back. */
export type DecideAndRoute = (
  canonicalOrigin: string,
  manifest: Manifest,
  tree: BundleTree,
  entries: readonly StagedAsset[],
  declaration: DdocDeclaration | undefined,
  content: ContentAddress | undefined,
  context: LoadContext
) => Promise<LoadResult>

/** What `Loader` offers for an installed app reached at a name: updates, the questions already answered, and the manifests a judgement is bound by. */
export interface AppUpdateApi {
  /**
   * Fetches and decides the update `load()` offered for `origin`'s name (`update-available`),
   * for the root `toCid` only: refused when the name has moved again since. The result is what
   * `load()` returns for a bundle in hand: an install, or one of the three questions.
   */
  applyUpdate(origin: string, toCid: string, context: LoadContext): Promise<LoadResult>

  /** The offers `origin`'s person asked not to hear about again (`./update-offer.ts`); never throws. */
  quietOffers(origin: string): Promise<UpdateOfferRecord>

  /** Remembers that `origin`'s person asked not to hear about `offer` again. Best effort: a lost write asks once more. */
  keepQuiet(origin: string, offer: QuietOffer): Promise<void>

  /** The manifest the pin holds for `origin`: no network call. `undefined` when never pinned or the stored manifest no longer matches the pin. */
  manifestFor(origin: string): Promise<Manifest | undefined>

  /**
   * The manifest of the content `cid` names, read through `origin`'s own content-addressed
   * route and nothing else of the bundle. Kept per (origin, CID) once the read has an answer,
   * an app or a website; a failed read is asked again.
   */
  manifestAt(origin: string, cid: string): Promise<ManifestAtRoot>
}

export interface NameUpdates {
  /** `undefined` when `origin`'s name no longer leads to IPFS content: the ordinary path then decides. */
  check: (hintedUrl: string, origin: string, pin: PinRecord, context: LoadContext, recheck: boolean) => Promise<LoadResult | undefined>
  apply: (hintedUrl: string, origin: string, toCid: string, context: LoadContext) => Promise<LoadResult>
}

export function createNameUpdates (
  options: CreateLoaderOptions,
  contentOf: (origin: string) => Promise<ContentAddress | undefined | Extract<LoadResult, { outcome: 'rejected' }>>,
  decideAndRoute: DecideAndRoute
): NameUpdates {
  const checkedAt = new Map<string, number>()

  /** The same files under a new root: the manifest is byte-identical to the pinned one. */
  async function sameManifest (origin: string, pin: PinRecord, bytes: Uint8Array): Promise<boolean> {
    const pinned = pin.assets.find((asset) => asset.path === MANIFEST_PATH)?.leaf
    return pinned !== undefined && await leafOf(MANIFEST_PATH, bytes.length, [bytes]) === pinned
  }

  async function check (hintedUrl: string, origin: string, pin: PinRecord, context: LoadContext, recheck: boolean): Promise<LoadResult | undefined> {
    const last = checkedAt.get(origin)
    if (!recheck && last !== undefined && checkedRecently(last, options.now(), NAME_CHECK_INTERVAL_MS)) return { outcome: 'up-to-date', canonicalOrigin: origin }
    const content = await contentOf(origin)
    if (content !== undefined && 'outcome' in content) return content
    if (content === undefined) return undefined
    checkedAt.set(origin, options.now())

    const fromCid = pin.content?.cid
    if (content.cid === fromCid) {
      const previous = await loadCheckRecord(options.storage, origin)
      await saveCheckRecord(options.storage, origin, checkRecord(options.now(), previous?.validators, previous?.manifestLeaf ?? await pinnedManifestLeaf(options.storage, origin)))
      return { outcome: 'up-to-date', canonicalOrigin: origin, atPinnedContent: true }
    }

    const read = await fetchManifestAtRoot(options.fetch, options.resolve, origin, content.cid)
    if (read.kind === 'unread') return { outcome: 'rejected', reason: `the manifest at ${origin}'s new content could not be read: ${read.reason}` }
    if (read.kind === 'website') return { outcome: 'rejected', reason: `${origin}'s new content has no manifest` }

    if (await sameManifest(origin, pin, read.bytes)) {
      const fetched = await fetchBundle(pinnedToRoot(options.fetch, content.cid), hintedUrl, options.resolve, options.storage)
      if (!fetched.ok) return { outcome: 'rejected', reason: fetched.reason }
      if (fetched.tree.root === pin.bundleHash) {
        return await decideAndRoute(fetched.canonicalOrigin, fetched.manifest, fetched.tree, fetched.entries, fetched.declaration, content, context)
      }
      await options.storage.clearStaging(origin).catch(() => {})
    }
    return { outcome: 'update-available', canonicalOrigin: origin, fromCid: fromCid ?? '', toCid: content.cid, manifest: read.manifest, pointersVerified: content.pointersVerified }
  }

  async function apply (hintedUrl: string, origin: string, toCid: string, context: LoadContext): Promise<LoadResult> {
    const content = await contentOf(origin)
    if (content === undefined) return { outcome: 'rejected', reason: `${origin} no longer points at IPFS content` }
    if ('outcome' in content) return content
    if (content.cid !== toCid) return { outcome: 'rejected', reason: `${origin} moved again since the update was offered; it will be offered again`, movedAgain: true }
    const fetched = await fetchBundle(pinnedToRoot(options.fetch, toCid), hintedUrl, options.resolve, options.storage)
    if (!fetched.ok) return { outcome: 'rejected', reason: fetched.reason }
    return await decideAndRoute(fetched.canonicalOrigin, fetched.manifest, fetched.tree, fetched.entries, fetched.declaration, content, context)
  }

  return { check, apply }
}
