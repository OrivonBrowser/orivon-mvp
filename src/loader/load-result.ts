// What one load() can end in: the six outcomes src/loader/index.ts routes
// to. A pending outcome carries everything installing needs, so a caller
// acting on the person's answer never fetches again.

import type { Manifest } from '../contracts/index.js'
import type { BundleTree } from '../broker/policy/bundle-hash.js'
import type { ContentAddress, PinRecord } from '../broker/policy/pin.js'
import type { PatternSet } from '../broker/policy/update.js'
import type { DdocDeclaration } from './ddoc-declaration.js'
import type { StagedAsset } from './fetch-bundle.js'

export interface LoadInstalled {
  readonly outcome: 'installed'
  readonly canonicalOrigin: string
  readonly manifest: Manifest
  readonly pin: PinRecord
  /**
   * True only when this install is a below-floor version the user has
   * already chosen, at least once, to accept from this origin
   * (decideUpdate()'s `rollback-notice`). Absent for every other
   * install -- the caller uses this to show an ongoing, passive,
   * non-blocking notice, never a prompt (the owner's own "warn every time,
   * but never require a click" framing). Never present alongside a TOFU or
   * ordinary `silent` install.
   *
   * A caller that ignores this field still gets a SAFE install --
   * decideUpdate() only reaches `rollback-notice` once it has confirmed the
   * update neither widens authority nor changes the bundle in a way that
   * would need reconsent (`ADR-0013`). What a caller loses by ignoring it is purely
   * the ongoing visibility the owner asked for -- the user never being told
   * they are still running an origin's below-floor version -- which is the
   * entire reason this outcome is distinguished from an ordinary `installed`
   * result rather than folded into it. A future caller keyed only on
   * `outcome === 'installed'` (an `installFromHint`-shaped helper, say) has
   * to consciously decide to drop that visibility, not do it by accident.
   */
  readonly rollbackNotice?: true
  /**
   * Set by `src/main/install/app-install.ts`, never by this loader: this
   * install is what registered the origin with the broker this session. A
   * tab built before that has no app-tab flag, so it runs without its
   * shims until it reloads once.
   */
  readonly newlyRegistered?: true
}

export interface LoadNeedsReconsent {
  readonly outcome: 'needs-reconsent'
  readonly canonicalOrigin: string
  readonly manifest: Manifest
  readonly tree: BundleTree
  /** Every leaf, waiting in staging -- so a caller can persist after approval without re-fetching. */
  readonly entries: readonly StagedAsset[]
  /** The hash tree the site published with this bundle, stored beside the pin on approval. */
  readonly declaration: DdocDeclaration | undefined
  /** Where the bundle came from when it was fetched from IPFS, pinned with it on approval. */
  readonly content: ContentAddress | undefined
}

export interface LoadNeedsCapabilityPrompt {
  readonly outcome: 'needs-capability-prompt'
  readonly canonicalOrigin: string
  readonly manifest: Manifest
  readonly tree: BundleTree
  readonly entries: readonly StagedAsset[]
  readonly declaration: DdocDeclaration | undefined
  readonly content: ContentAddress | undefined
  /** What the new manifest asks for -- the prompt's own job to render, not this file's. */
  readonly requestedPatterns: PatternSet
}

/**
 * T19: a below-floor version is a warned CHOICE the first time for a given
 * origin -- proceed with this older version, or keep what's cached -- never
 * a hard block. Carries `tree`/`entries`/`manifest` for the same
 * reason `LoadNeedsReconsent`/`LoadNeedsCapabilityPrompt` carry them --
 * so a caller doesn't have to re-fetch to act on the choice.
 *
 * NOT the same reason, though: for those two, approving is terminal --
 * `widensAuthority`/`isSameBundle` (`ordinaryEscalation`, `update.ts`)
 * already ran, so persisting the result on approval is safe. Here they have
 * NOT run yet -- `decideUpdate` returns `rollback-choice` before either
 * check, so this manifest could also widen capabilities. Approving must
 * record the acknowledgement and let `decideUpdate` run again (this time
 * reaching `ordinaryEscalation`), never persist this result directly.
 */
export interface LoadNeedsRollbackChoice {
  readonly outcome: 'needs-rollback-choice'
  readonly canonicalOrigin: string
  readonly manifest: Manifest
  readonly tree: BundleTree
  readonly entries: readonly StagedAsset[]
  readonly declaration: DdocDeclaration | undefined
  readonly content: ContentAddress | undefined
  /** The origin's own floor, so a prompt can say what's already been seen, not just what's being offered now. */
  readonly versionFloor: string
}

export interface LoadRejected {
  readonly outcome: 'rejected'
  /**
   * Developer-facing, same stance as fetch-bundle.ts's FetchBundleRejected --
   * and, additionally, never a host filesystem path. Every other rejection
   * here is a string this module wrote about the fetch or the manifest; the
   * storage one is the only place a raw node:fs message could reach this
   * field, and installAndNotify (./install.ts) logs that message rather
   * than returning it.
   */
  readonly reason: string
}

/** This origin was checked less than `updateCheckIntervalMs` ago, or its host answered the conditional manifest request with 304; no bundle was fetched and nothing changed. */
export interface LoadUpToDate {
  readonly outcome: 'up-to-date'
  readonly canonicalOrigin: string
}

export type LoadResult = LoadInstalled | LoadNeedsReconsent | LoadNeedsCapabilityPrompt | LoadNeedsRollbackChoice | LoadRejected | LoadUpToDate
