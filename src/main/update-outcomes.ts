// Drives Loader.load()'s three pending outcomes -- needs-reconsent,
// needs-capability-prompt, needs-rollback-choice -- to a real decision
// (S4-5, docs/planning/step-4-app-loader-plan.md). Each one already
// carries the fetched, validated tree/entries specifically so accepting it
// never re-fetches (src/loader/index.ts's own header on Loader
// .installFetched/.reconsider): a second fetch would give the server a
// second chance to serve different bytes than what the person was shown,
// which is a correctness requirement, not an optimisation.
//
// ./app-install.ts calls driveLoadResult with everything Loader.load()
// returns; this file owns what happens next, the same Electron-free split
// ./install-consent.ts already uses for d-0025 -- the real dialogs are
// ./update-outcomes-prompt.ts.
//
// EVERY PROMPT HERE IS OPTIONAL AND FAILS CLOSED, exactly like
// AppInstallDeps.consent already does: an undefined prompt, one that
// throws, or one that resolves false, all return the ORIGINAL pending
// result UNCHANGED -- nothing is installed, nothing is granted, and the
// previously pinned bundle (already being served from an earlier visit) is
// untouched. That is what "decline is safe" means here: not a special case
// per outcome, just never calling installFetched/reconsider/grant.

import type { PatternSet } from '../broker/policy/update.js'
import type { Broker } from '../broker/broker-contracts.js'
import type { CapabilityKind, Manifest } from '../contracts/index.js'
import type { LoadContext, LoadInstalled, LoadResult, Loader } from '../loader/index.js'
import { requestInstallConsent } from './install-consent.js'
import type { InstallConsentPrompt } from './install-consent.js'
import { grantChangedCapabilities } from './grant-changed-capabilities.js'

export type ReconsentPrompt = (origin: string, manifest: Manifest) => Promise<boolean>
export type CapabilityPromptPrompt = (origin: string, manifest: Manifest, requestedPatterns: PatternSet) => Promise<boolean>
export type RollbackChoicePrompt = (origin: string, manifest: Manifest, versionFloor: string) => Promise<boolean>

export interface UpdateOutcomeDeps {
  readonly broker: Broker
  readonly loader: Loader
  readonly consent?: InstallConsentPrompt
  readonly reconsentPrompt?: ReconsentPrompt
  readonly capabilityPrompt?: CapabilityPromptPrompt
  readonly rollbackChoicePrompt?: RollbackChoicePrompt
}

/**
 * Every path that reaches a real `LoadInstalled` goes through here exactly
 * once -- app-install.ts's own `registerApp`/consent side effects (A60's
 * ordering rule; install-consent.ts's "once ever" derivation), whether the
 * install came from a fresh `load()`, an accepted reconsent, an accepted
 * capability widening, or an accepted rollback. One place, so the call
 * sites below cannot each pick a different subset of these side effects.
 * `registerApp` is safe to call again on every one of these paths --
 * `GrantLedger.registerApp` only ever RAISES the floor and leaves existing
 * grants untouched (grant-ledger.ts's own doc), so re-registering the same
 * or an older manifest is a no-op on top of what is already there.
 */
async function finishInstall (deps: UpdateOutcomeDeps, result: LoadInstalled): Promise<LoadInstalled> {
  try {
    await deps.broker.registerApp(result.canonicalOrigin, result.manifest)
  } catch (error) {
    console.error('[app-install] registerApp failed after a successful install; the bundle is installed but its version floor was not persisted', result.canonicalOrigin, error)
  }
  await requestInstallConsent(deps.broker, deps.consent, result.canonicalOrigin, result.manifest)
  return result
}

/**
 * The one entry point ./app-install.ts calls with whatever `Loader.load()`
 * -- or, on an accepted rollback, `Loader.reconsider()` -- just returned.
 * `context` is the SAME `LoadContext` `installFromHint` already built for
 * the `load()` call that produced `result`, reused verbatim for a
 * rollback's `reconsider()` call below with only
 * `acknowledgedRollbackVersion` moved forward -- never recomputed from
 * scratch.
 */
export async function driveLoadResult (deps: UpdateOutcomeDeps, result: LoadResult, context: LoadContext): Promise<LoadResult> {
  switch (result.outcome) {
    case 'installed':
      return await finishInstall(deps, result)

    case 'rejected':
      return result

    case 'needs-reconsent': {
      if (deps.reconsentPrompt === undefined) return result
      let accepted: boolean
      try {
        accepted = await deps.reconsentPrompt(result.canonicalOrigin, result.manifest)
      } catch (error) {
        console.error('[app-install] the reconsent prompt threw; treating this update as declined', result.canonicalOrigin, error)
        return result
      }
      if (!accepted) return result
      // NO SECOND FETCH: `result.tree`/`result.entries` are exactly the
      // bytes the person was just shown -- see Loader.installFetched's own
      // doc for why re-fetching here would be a correctness defect, not a
      // missed optimisation.
      const installed = await deps.loader.installFetched(result.canonicalOrigin, result.manifest, result.tree, result.entries)
      return installed.outcome === 'installed' ? await finishInstall(deps, installed) : installed
    }

    case 'needs-capability-prompt': {
      if (deps.capabilityPrompt === undefined) return result
      let accepted: boolean
      try {
        accepted = await deps.capabilityPrompt(result.canonicalOrigin, result.manifest, result.requestedPatterns)
      } catch (error) {
        console.error('[app-install] the capability prompt threw; treating this update as declined', result.canonicalOrigin, error)
        return result
      }
      if (!accepted) return result
      const installed = await deps.loader.installFetched(result.canonicalOrigin, result.manifest, result.tree, result.entries)
      if (installed.outcome !== 'installed') return installed
      // Same idiom update.ts's widensAuthority uses for a PatternSet's own
      // keys: every key in `requestedPatterns` was set by
      // patternSetFromCapabilities itself (src/loader/index.ts), so this
      // cast trusts nothing untrusted.
      await grantChangedCapabilities(deps.broker, installed.canonicalOrigin, installed.manifest, Object.keys(result.requestedPatterns) as readonly CapabilityKind[])
      return await finishInstall(deps, installed)
    }

    case 'needs-rollback-choice': {
      if (deps.rollbackChoicePrompt === undefined) return result
      let accepted: boolean
      try {
        accepted = await deps.rollbackChoicePrompt(result.canonicalOrigin, result.manifest, result.versionFloor)
      } catch (error) {
        console.error('[app-install] the rollback choice prompt threw; treating this update as declined', result.canonicalOrigin, error)
        return result
      }
      if (!accepted) return result
      try {
        // A68/d-0017: acknowledges EXACTLY this version, never a per-origin
        // flag -- see GrantLedger.acknowledgeRollback's own doc for why a
        // flag would let one accepted rollback cover any other below-floor
        // version the same origin later serves.
        await deps.broker.acknowledgeRollback(result.canonicalOrigin, result.manifest.version)
      } catch (error) {
        // The in-memory acknowledgement already landed either way
        // (GrantLedger.acknowledgeRollback's own doc, same shape as
        // registerApp) -- a disk write failing here is logged, not fatal to
        // this visit.
        console.error('[app-install] acknowledgeRollback failed to persist; proceeding for this session anyway', result.canonicalOrigin, error)
      }
      // NO SECOND FETCH: decideUpdate() has not yet run its widening/
      // bundle-change checks for a below-floor version
      // (LoadNeedsRollbackChoice's own doc, ADR-0013's 2026-09-05
      // amendment) -- reconsider() re-runs that decision against the SAME
      // already-fetched tree/entries. Its result can itself be 'installed'
      // (rollback-notice), 'needs-reconsent' or 'needs-capability-prompt' --
      // driven through this same function, recursively, exactly like a
      // fresh load() result would be.
      const reconsidered = await deps.loader.reconsider(result.canonicalOrigin, result.manifest, result.tree, result.entries, {
        ...context,
        acknowledgedRollbackVersion: result.manifest.version
      })
      return await driveLoadResult(deps, reconsidered, context)
    }

    default: {
      // Exhaustiveness guard: a compile error at `exhaustive` is how a new
      // LoadResult outcome added without a case here gets caught, not a
      // runtime path reachable through the closed union above (matches
      // app-install.ts's own former switch, and
      // src/telemetry/accounting.ts's applyEvent).
      const exhaustive: never = result
      throw new Error(`driveLoadResult: unhandled LoadResult outcome ${JSON.stringify(exhaustive)}`)
    }
  }
}
