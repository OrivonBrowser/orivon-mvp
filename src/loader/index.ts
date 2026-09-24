// The app loader's fetch-and-cache path: createLoader({fetch, storage, now})
// mirrors how src/broker/index.ts builds createBroker -- injected effects,
// no Electron import, unit-testable against stubs. This file is the
// orchestration only; fetching+hashing+entry-checking is fetch-bundle.ts,
// the Manifest.capabilities -> PatternSet mapping is update-patterns.ts, and
// the storage seam is storage.ts. See src/loader/README.md.
//
// THE SIX OUTCOMES: `installed` (TOFU, a `silent` decideUpdate() verdict,
// or an ALREADY-ACKNOWLEDGED rollback -- all three mean "ready to run,
// nothing new to ask the user"), `needs-reconsent`, `needs-capability-
// prompt`, `needs-rollback-choice`, `rejected`, and `up-to-date` (checked
// too recently to check again). Showing UI for the three prompts, or
// wiring the broker's grant prompt, is explicitly out of scope here
// (src/loader/README.md) -- this function returns the verdict and stops.
//
// CRITERION 4: decideUpdate() is called with `context.grantedPatterns` --
// what the grant ledger actually holds -- NEVER `manifest.capabilities`.
// This codebase has a filed history of exactly that mistake (A18, A27).
// `context` is supplied by the caller because the grant ledger lives in
// src/broker/, which this file does not read; see LoadContext below.

import type { CapabilityKind, Manifest } from '../contracts/index.js'
import type { BundleTree } from '../broker/policy/bundle-hash.js'
import type { Resolver } from '../broker/policy/connect.js'
import { parsePinRecord } from '../broker/policy/pin.js'
import type { PinRecord } from '../broker/policy/pin.js'
import { decideUpdate } from '../broker/policy/update.js'
import type { PatternSet } from '../broker/policy/update.js'
import { withoutSwitchedOffCapabilities } from '../broker/policy/manifest-patterns.js'
import { fetchBundle } from './fetch-bundle.js'
import type { Fetch, StagedAsset } from './fetch-bundle.js'
import { installAndNotify } from './install.js'
import { parseDdocDeclaration } from './ddoc-declaration.js'
import type { DdocDeclaration } from './ddoc-declaration.js'
import type { LoaderStorage } from './storage.js'
import { patternSetFromCapabilities } from './update-patterns.js'
import { originFromUrl } from '../broker/policy/origin.js'
import { MANIFEST_PATH } from '../broker/policy/canonical-path.js'
import { leafOf } from './leaf-hash.js'
import { parseManifest } from './manifest.js'
import { checkRecord, checkedRecently, loadCheckRecord, pinnedManifestLeaf, saveCheckRecord, validatorsForPin } from './update-check.js'

export type { Fetch, FetchResponse } from './fetch-bundle.js'
export type { LoaderStorage } from './storage.js'
export { appRootDirectoryName } from './storage.js'

export interface CreateLoaderOptions {
  readonly fetch: Fetch
  readonly storage: LoaderStorage
  /** Clock, read once per install/refetch (`PinRecord.pinnedAt`). Injected so a test can freeze it -- matches createBroker's own `now`. */
  readonly now: () => number
  /**
   * T12/A46: resolves the install origin's hostname before
   * fetchBundle.ts's first network request -- see that file's own
   * `ensurePublicUnicastOrigin` for why this belongs there, not here. Same
   * `Resolver` shape `policy/connect.ts` already defines; no second type for
   * one idea (Rule 3). The real implementation wired in
   * (`electron-resolve.ts`'s `electronResolveHost`) is deliberately NOT the
   * broker's own node:dns-based one -- see that file's header for why the
   * loader needs Chromium's own resolver instead.
   */
  readonly resolve: Resolver
  /**
   * Called after a bundle is actually persisted (TOFU, `silent`, or
   * `rollback-notice` -- every path that reaches `installOrReject` below),
   * never on `rejected` or a still-pending prompt outcome. `electron-
   * serve.ts`'s `registerServingFor` is the real implementation this closes
   * over (`subsystem.ts`) -- ADR-0007's serving mechanism, so an app already
   * works from cache within the SAME run it was installed in, not only
   * after a restart (`electron-serve.ts`'s own `restorePinnedServing`
   * covers that second case). A failure here is logged and does not fail
   * the install it followed -- the same "one thing going wrong here must
   * not undo a bundle that is genuinely, correctly on disk" stance
   * `installOrReject` itself already takes for storage failures.
   */
  readonly onInstalled?: (origin: string) => Promise<void>
  /**
   * When set, `load()` answers `'up-to-date'` without fetching anything for
   * an origin whose last completed check (any outcome but `'rejected'`) was
   * less than this many milliseconds ago, a record kept in `storage` so it
   * survives a restart; and a later check asks for the manifest
   * conditionally, answering `'up-to-date'` on a 304 without downloading
   * the bundle. Unset means every call checks in full.
   */
  readonly updateCheckIntervalMs?: number
}

/**
 * The interval `subsystem.ts` passes as `updateCheckIntervalMs`: an app is
 * checked for an update at most once an hour, restarts included.
 * AI-recommended; the owner confirms the number.
 */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60_000

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
  /**
   * The SPECIFIC below-floor version this origin's rollback was last
   * acknowledged for (`Broker.rollbackAcknowledgedVersionFor`), or
   * `undefined` if never acknowledged. NOT the boolean `decideUpdate()`
   * itself wants -- this file supplies that boolean itself, at the point it
   * calls `decideUpdate()`, by comparing this value against the manifest's
   * ACTUAL offered version once fetchBundle() has returned it.
   *
   * Deliberately not a precomputed boolean: the caller of `load()` cannot
   * know the offered version in advance (fetching the manifest is this
   * file's own job, not the caller's -- see its header), so it cannot
   * correctly decide "is this acknowledged" itself. Asking it to would force
   * a guess or a second fetch. Handing over the raw acknowledged version
   * and letting THIS file do the comparison once it actually knows what is
   * being offered is the only point where both facts are available at once.
   */
  readonly acknowledgedRollbackVersion: string | undefined
  /**
   * Capability kinds this origin's person has explicitly switched off from
   * the site-info popover (`Broker.declinedCapabilitiesFor`, the same
   * advisory record install-consent declines already use) -- optional so
   * every pre-existing `LoadContext` literal keeps compiling unchanged.
   * `decideAndRoute` below drops a switched-off, not-currently-held kind
   * from what it asks `decideUpdate` to treat as newly requested, so a
   * still-declared but turned-off capability does not reappear as a prompt
   * on the next visit. See `withoutSwitchedOffCapabilities`'s own doc
   * (`../broker/policy/manifest-patterns.js`) for why "not currently held"
   * is the condition, not "declined" alone. Typed with an explicit
   * `| undefined` rather than optional-alone: `Broker.declinedCapabilitiesFor`
   * (this field's real source, `../main/install/app-install.js`) resolves
   * `undefined` for "never declined", and `exactOptionalPropertyTypes`
   * requires that value be a legal one to assign, not merely an omittable key.
   */
  readonly declinedCapabilities?: readonly CapabilityKind[] | undefined
}

export interface LoadInstalled {
  readonly outcome: 'installed'
  readonly canonicalOrigin: string
  readonly manifest: Manifest
  readonly pin: PinRecord
  /**
   * True only when this install is a below-floor version the user has
   * already chosen, at least once, to accept from this origin
   * (decideUpdate()'s `rollback-notice`, 2026-09-04). Absent for every other
   * install -- the caller uses this to show an ongoing, passive,
   * non-blocking notice, never a prompt (the owner's own "warn every time,
   * but never require a click" framing). Never present alongside a TOFU or
   * ordinary `silent` install.
   *
   * A caller that ignores this field still gets a SAFE install --
   * decideUpdate() only reaches `rollback-notice` once it has confirmed the
   * update neither widens authority nor changes the bundle in a way that
   * would need reconsent (fixed 2026-09-05, `ADR-0013`'s own amendment: it
   * used to skip those checks entirely for an acknowledged rollback, which is
   * why this field existing was not enough on its own). What a caller loses by ignoring it is purely
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
}

export interface LoadNeedsCapabilityPrompt {
  readonly outcome: 'needs-capability-prompt'
  readonly canonicalOrigin: string
  readonly manifest: Manifest
  readonly tree: BundleTree
  readonly entries: readonly StagedAsset[]
  readonly declaration: DdocDeclaration | undefined
  /** What the new manifest asks for -- the prompt's own job to render, not this file's. */
  readonly requestedPatterns: PatternSet
}

/**
 * 2026-09-04, T19 policy reversal: a below-floor version used to be a
 * silent, no-prompt `rejected`. It is now a warned CHOICE the first time for
 * a given origin -- proceed with this older version, or keep what's cached
 * -- never a hard block. Carries `tree`/`entries`/`manifest` for the same
 * reason `LoadNeedsReconsent`/`LoadNeedsCapabilityPrompt` carry them --
 * so a caller doesn't have to re-fetch to act on the choice.
 *
 * NOT the same reason, though: for those two, approving is terminal --
 * `widensAuthority`/`isSameBundle` (`ordinaryEscalation`, `update.ts`)
 * already ran, so persisting the result on approval is safe. Here they have
 * NOT run yet -- `decideUpdate` returns `rollback-choice` before either
 * check, so this manifest could also widen capabilities. Approving must
 * record the acknowledgement and let `decideUpdate` run again (now correctly
 * reaching `ordinaryEscalation`), never persist this result directly.
 */
export interface LoadNeedsRollbackChoice {
  readonly outcome: 'needs-rollback-choice'
  readonly canonicalOrigin: string
  readonly manifest: Manifest
  readonly tree: BundleTree
  readonly entries: readonly StagedAsset[]
  readonly declaration: DdocDeclaration | undefined
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
   * field, and installOrReject below logs that message rather than returning
   * it.
   */
  readonly reason: string
}

/** This origin was checked less than `updateCheckIntervalMs` ago, or its host answered the conditional manifest request with 304; no bundle was fetched and nothing changed. */
export interface LoadUpToDate {
  readonly outcome: 'up-to-date'
  readonly canonicalOrigin: string
}

export type LoadResult = LoadInstalled | LoadNeedsReconsent | LoadNeedsCapabilityPrompt | LoadNeedsRollbackChoice | LoadRejected | LoadUpToDate

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
   * The app's own file list is never supplied here -- fetch-bundle.ts reads
   * it off the manifest itself (`entry` unioned with `assets`, ADR-0011)
   * once it has fetched and parsed it. A passive discovery trigger never has
   * anything but `hintedUrl` to start from (docs/open-questions.md A45).
   */
  load(hintedUrl: string, context: LoadContext): Promise<LoadResult>

  /**
   * S4-5: installs a bundle already fetched and validated by a prior
   * `load()` call -- the terminal step for an ACCEPTED `needs-reconsent` or
   * `needs-capability-prompt` outcome (see each one's own doc: approving is
   * terminal there, because `decideUpdate()`'s widening/bundle-change checks
   * already ran to produce them).
   *
   * NEVER RE-FETCHES, and that is the entire reason this method exists
   * rather than a caller just calling `load()` again. The person has
   * already been shown, and approved, exactly `tree`/`entries` -- fetching
   * again before persisting would give the server a second chance to serve
   * DIFFERENT bytes than what was approved, which is a correctness defect,
   * not a missed optimisation.
   */
  installFetched(canonicalOrigin: string, manifest: Manifest, tree: BundleTree, entries: readonly StagedAsset[], declaration: DdocDeclaration | undefined): Promise<LoadInstalled | LoadRejected>

  /**
   * S4-5: re-runs the update decision against an ALREADY-FETCHED
   * `tree`/`entries` -- no network call -- for a caller driving
   * `needs-rollback-choice` to acceptance (`ADR-0013`,
   * `LoadNeedsRollbackChoice`'s own doc).
   *
   * UNLIKE `needs-reconsent`/`needs-capability-prompt`, approving a
   * rollback is NOT terminal: `decideUpdate()` returns `'rollback-choice'`
   * BEFORE its widening/bundle-change checks run, so this same manifest
   * could also widen capabilities or carry different code than what is
   * pinned. The caller acknowledges the rollback first
   * (`Broker.acknowledgeRollback`), then calls this with `context`'s
   * `acknowledgedRollbackVersion` updated to match `manifest.version` --
   * `decideAndRoute` (this file) then applies EXACTLY the same escalation
   * an ordinary update would, and the result can itself be `'installed'`
   * (with `rollbackNotice: true`), `'needs-reconsent'`, or
   * `'needs-capability-prompt'` -- never `'needs-rollback-choice'` again,
   * since the floor check now passes.
   */
  reconsider(canonicalOrigin: string, manifest: Manifest, tree: BundleTree, entries: readonly StagedAsset[], declaration: DdocDeclaration | undefined, context: LoadContext): Promise<LoadResult>

  /**
   * The pin currently on disk for `origin`, or `null` if never pinned or
   * unreadable -- `../main/browsing/site-trust.js`'s own read of what is
   * actually there, with no network call and no side effect, unlike
   * `load()`. Same parse `decideAndRoute` uses internally, exposed
   * read-only.
   */
  pinFor(origin: string): Promise<PinRecord | null>

  /** The hash tree the site published with its pinned bundle, or `undefined` when it published none readable. Same read-only stance as `pinFor`. */
  ddocFor(origin: string): Promise<DdocDeclaration | undefined>
}

/**
 * What the pinned manifest declared -- decideUpdate's
 * `previouslyDeclaredPatterns`, so a capability the person already declined
 * (or revoked) is not asked about again on every visit. Read back only if
 * its bytes still hash to the pin's own manifest leaf; undefined otherwise.
 */
async function pinnedDeclaredPatterns (storage: LoaderStorage, origin: string, pin: PinRecord | null): Promise<PatternSet | undefined> {
  const leaf = pin?.assets.find((asset) => asset.path === MANIFEST_PATH)?.leaf
  if (leaf === undefined) return undefined
  const bytes = await storage.readAsset(origin, MANIFEST_PATH)
  if (bytes === undefined || await leafOf(MANIFEST_PATH, bytes.length, [bytes]) !== leaf) return undefined
  const parsed = parseManifest(new TextDecoder().decode(bytes))
  return parsed.ok ? patternSetFromCapabilities(parsed.manifest.capabilities) : undefined
}

/**
 * Everything `load()` does once a bundle is IN HAND -- read the existing
 * pin, run `decideUpdate()`, and route to one of the five outcomes.
 * Factored out of `load()` so `Loader.reconsider` (below) can run this
 * SAME decision again, against the SAME already-fetched `tree`/`entries`,
 * with no second network fetch (S4-5, `LoadNeedsRollbackChoice`'s own doc
 * on why an accepted rollback must re-run this rather than skip straight
 * to installing).
 */
async function decideAndRoute (
  options: CreateLoaderOptions,
  canonicalOrigin: string,
  manifest: Manifest,
  tree: BundleTree,
  entries: readonly StagedAsset[],
  declaration: DdocDeclaration | undefined,
  context: LoadContext
): Promise<LoadResult> {
  const rawPin = await options.storage.readPin(canonicalOrigin)
  if (rawPin === undefined) {
    // TOFU (ADR-0005): nothing was ever pinned for this origin, so there
    // is no continuity to protect and nothing to prompt for.
    return await installAndNotify(options, canonicalOrigin, manifest, tree, entries, declaration, undefined)
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

  // The full declared set still names `requestedPatterns` below on a real
  // capability-prompt outcome (every screen shows the WHOLE outstanding
  // request, install-consent.ts's own convention) -- only the WIDENING
  // CHECK itself is narrowed, so a capability the person switched off does
  // not read as newly requested on every later visit while it stays off.
  const declaredPatterns = patternSetFromCapabilities(manifest.capabilities)
  const decision = decideUpdate({
    pinnedHash,
    newHash: tree.root,
    grantedPatterns: context.grantedPatterns,
    newPatterns: withoutSwitchedOffCapabilities(declaredPatterns, context.grantedPatterns, context.declinedCapabilities),
    version: manifest.version,
    versionFloor: context.versionFloor,
    // The comparison LoadContext.acknowledgedRollbackVersion's own doc
    // promises: only NOW is the actual offered version known, so only
    // now can "was THIS version acknowledged" be answered.
    rollbackAcknowledged: context.acknowledgedRollbackVersion === manifest.version,
    previouslyDeclaredPatterns: await pinnedDeclaredPatterns(options.storage, canonicalOrigin, existingPin)
  })

  switch (decision) {
    case 'rollback-choice':
      return { outcome: 'needs-rollback-choice', canonicalOrigin, manifest, tree, entries, declaration, versionFloor: context.versionFloor }
    case 'capability-prompt':
      return {
        outcome: 'needs-capability-prompt',
        canonicalOrigin,
        manifest,
        tree,
        entries,
        declaration,
        requestedPatterns: declaredPatterns
      }
    case 'reconsent':
      return { outcome: 'needs-reconsent', canonicalOrigin, manifest, tree, entries, declaration }
    case 'silent':
      return await installAndNotify(options, canonicalOrigin, manifest, tree, entries, declaration, existingPin)
    case 'rollback-notice': {
      const result = await installAndNotify(options, canonicalOrigin, manifest, tree, entries, declaration, existingPin)
      return result.outcome === 'installed' ? { ...result, rollbackNotice: true } : result
    }
    default: {
      // Exhaustiveness guard: a compile error at `exhaustive` is how a new
      // UpdateDecision case added without a branch here gets caught, not a
      // runtime path reachable through the closed union above (same
      // pattern as src/telemetry/accounting.ts's applyEvent).
      const exhaustive: never = decision
      throw new Error(`loader: unhandled update decision ${JSON.stringify(exhaustive)}`)
    }
  }
}

export function createLoader (options: CreateLoaderOptions): Loader {
  async function load (hintedUrl: string, context: LoadContext): Promise<LoadResult> {
    const interval = options.updateCheckIntervalMs
    const origin = originFromUrl(hintedUrl)
    if (interval === undefined || origin === null) return await checkInFull(hintedUrl, context)

    const previous = await loadCheckRecord(options.storage, origin)
    if (previous !== undefined && checkedRecently(previous.checkedAt, options.now(), interval)) {
      return { outcome: 'up-to-date', canonicalOrigin: origin }
    }
    const validators = await validatorsForPin(options.storage, origin, previous)
    const fetched = await fetchBundle(options.fetch, hintedUrl, options.resolve, options.storage, undefined, validators)
    if ('notModified' in fetched) {
      await saveCheckRecord(options.storage, origin, checkRecord(options.now(), validators, previous?.manifestLeaf))
      return { outcome: 'up-to-date', canonicalOrigin: origin }
    }
    if (!fetched.ok) return { outcome: 'rejected', reason: fetched.reason }
    const result = await decideAndRoute(options, fetched.canonicalOrigin, fetched.manifest, fetched.tree, fetched.entries, fetched.declaration, context)
    if (result.outcome === 'installed') {
      await saveCheckRecord(options.storage, origin, checkRecord(options.now(), fetched.validators, await pinnedManifestLeaf(options.storage, origin)))
    } else if (result.outcome !== 'rejected') {
      // Nothing was installed, so the pin, and the validators that describe it, are unchanged.
      await saveCheckRecord(options.storage, origin, checkRecord(options.now(), validators, previous?.manifestLeaf))
    }
    return result
  }

  async function checkInFull (hintedUrl: string, context: LoadContext): Promise<LoadResult> {
    const fetched = await fetchBundle(options.fetch, hintedUrl, options.resolve, options.storage)
    if (!fetched.ok) return { outcome: 'rejected', reason: fetched.reason }
    return await decideAndRoute(options, fetched.canonicalOrigin, fetched.manifest, fetched.tree, fetched.entries, fetched.declaration, context)
  }

  async function reconsider (
    canonicalOrigin: string,
    manifest: Manifest,
    tree: BundleTree,
    entries: readonly StagedAsset[],
    declaration: DdocDeclaration | undefined,
    context: LoadContext
  ): Promise<LoadResult> {
    return await decideAndRoute(options, canonicalOrigin, manifest, tree, entries, declaration, context)
  }

  async function installFetched (
    canonicalOrigin: string,
    manifest: Manifest,
    tree: BundleTree,
    entries: readonly StagedAsset[],
    declaration: DdocDeclaration | undefined
  ): Promise<LoadInstalled | LoadRejected> {
    // Every caller is acting on an approved needs-reconsent/needs-capability-
    // prompt outcome, and both exist only once decideAndRoute found a pin for
    // this origin -- so there is always one to read back here (possibly
    // unparseable: `null`, never the TOFU `undefined`).
    const existingPin = parsePinRecord(await options.storage.readPin(canonicalOrigin))
    return await installAndNotify(options, canonicalOrigin, manifest, tree, entries, declaration, existingPin)
  }

  async function pinFor (origin: string): Promise<PinRecord | null> {
    return parsePinRecord(await options.storage.readPin(origin))
  }

  async function ddocFor (origin: string): Promise<DdocDeclaration | undefined> {
    return parseDdocDeclaration(await options.storage.readDdoc(origin))
  }

  return { load, reconsider, installFetched, pinFor, ddocFor }
}
