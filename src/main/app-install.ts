// The loader-to-broker glue that has never existed (A60, A61,
// docs/open-questions.md). Loader.load()'s own header explains why this
// cannot live inside src/loader/ itself: LoadContext is caller-supplied
// specifically because the grant ledger lives in src/broker/, which the
// loader must not read directly. subsystems.ts's and loaderSubsystem's own
// headers already point at src/main/ as the intended home for this wiring
// ("shell UI, not loader construction").
//
// A60's own recommendation, followed exactly: registerApp fires ONLY when
// load() actually accepts the install (outcome 'installed'), never on a
// bare fetch/parse -- a hostile origin could otherwise poison the version
// floor with a fake high version and permanently lock itself (and the user)
// out of every real, lower-numbered future update.
//
// F3 (fleet run review-72-76): PR #72 (`stream/loader-08-rollback-warning`)
// and the `rollback-ack` PR (`stream/broker-22-rollback-ack-persistence`)
// are both still open, unmerged -- verified directly via `gh pr list`, not
// assumed. Neither this branch's `LoadContext` nor its `Broker` interface
// declares `rollbackAcknowledged` / `rollbackAcknowledgedVersionFor` today,
// so there is nothing to wire up yet; the sections below name exactly what
// changes once they land.

import { originFromUrl } from '../broker/policy/origin.js'
import { patternSetFromGrants } from '../broker/policy/update.js'
import type { Broker } from '../broker/broker-contracts.js'
import type { LoadResult, Loader } from '../loader/index.js'
import { withOriginQueue } from './origin-queue.js'

export interface AppInstallDeps {
  readonly broker: Broker
  readonly loader: Loader
}

/**
 * Installs (or advances the state of) the app at `hintedUrl`, gluing
 * together everything `Loader.load()` needs from the broker
 * (`LoadContext.grantedPatterns` via `patternSetFromGrants(await
 * broker.app.grants(origin))` -- A61's own recommendation, `versionFloor`
 * verbatim from `broker.versionFloorFor(origin)`) and everything the broker
 * needs back once `load()` decides (`registerApp`, A60's timing rule above).
 *
 * `hintingOrigin` is the origin that actually SUPPLIED the hint -- e.g.
 * `originFromSenderFrame(event.senderFrame)` (`src/broker/policy/
 * origin.ts`), already canonical. No real caller exists yet (the hint
 * listener isn't built), but this seam has to exist from day one: without
 * it, a hostile page could emit a hint for an unrelated origin (its bank,
 * say) and have this read THAT origin's grants and raise its version
 * floor. `hintedUrl` must resolve to EXACTLY `hintingOrigin` or this
 * rejects before the broker is ever touched (F10), matching `Loader.
 * load()`'s own same-origin contract.
 *
 * That same-origin check, and `originFromUrl` failing, both run before any
 * broker call (N2/N3): `GrantLedger.versionFloorFor` creates a permanent
 * in-memory record for any origin it is asked about at all, even a bogus
 * one, so validating first is not optional. What this does NOT run is the
 * full T12/SSRF resolution check `Loader.load()` itself will apply
 * (`src/loader/install-origin.ts`, being rewritten by a sibling, unmerged
 * lane) -- a known, accepted residual gap; see this lane's PR body.
 *
 * Wrapped in `withOriginQueue` (A62) so two calls for the same origin --
 * two tabs hitting the same manifest hint near-simultaneously -- never
 * interleave their `Loader.load()` calls into a corrupted on-disk state.
 */
export async function installFromHint (deps: AppInstallDeps, hintingOrigin: string, hintedUrl: string): Promise<LoadResult> {
  const origin = originFromUrl(hintedUrl)
  if (origin === null) return { outcome: 'rejected', reason: `hintedUrl is not a valid app origin: ${hintedUrl}` }
  if (hintingOrigin !== origin) {
    return { outcome: 'rejected', reason: `a hint from ${hintingOrigin} may only install its own origin's app, not ${origin}` }
  }

  return await withOriginQueue(origin, async () => {
    const [grants, versionFloor] = await Promise.all([
      deps.broker.app.grants(origin),
      deps.broker.versionFloorFor(origin)
    ])

    // F3: `LoadContext` has no `rollbackAcknowledged` field on this branch
    // yet -- see this file's header. DO NOT wire it up as `await deps.
    // broker.rollbackAcknowledgedVersionFor(origin) !== undefined` once it
    // does: that origin-only check reopens the exact flaw `rollback-ack`'s
    // storage redesign closed (one accepted rollback would silently cover
    // any later, unrelated below-floor version). The field must be derived
    // by comparing the ACKNOWLEDGED version against the version `Loader.
    // load()` is about to OFFER -- which this function cannot know until
    // `load()` itself fetches the manifest, after `LoadContext` must
    // already exist. Unresolved design gap, not this lane's file to fix
    // (`src/loader/`); see this lane's PR body.
    const result = await deps.loader.load(hintedUrl, {
      grantedPatterns: patternSetFromGrants(grants),
      versionFloor
    })

    switch (result.outcome) {
      case 'installed':
        try {
          await deps.broker.registerApp(result.canonicalOrigin, result.manifest)
        } catch (error) {
          // F16: the bundle is already on disk and `result` is already a
          // genuinely usable LoadInstalled -- registerApp rejects only on a
          // broker-internal fault (broker-contracts.ts's own doc), never on
          // anything the app did. Losing the floor persistence is real, but
          // less bad than telling the caller the install itself failed, or
          // discarding the only reference to what is now on disk. Logged
          // and swallowed, not rethrown: Promise<LoadResult> is documented
          // as never rejecting, and nothing consumes a side channel yet.
          console.error('[app-install] registerApp failed after a successful install; the bundle is installed but its version floor was not persisted', result.canonicalOrigin, error)
        }
        return result
      case 'needs-reconsent':
      case 'needs-capability-prompt':
      case 'rejected':
        // A60: registerApp fires only on an accepted install, never here --
        // returned exactly as loader.load() produced it.
        return result
      default: {
        // Exhaustiveness guard: a compile error at `exhaustive` is how a new
        // LoadResult outcome added without a case here gets caught, not a
        // runtime path reachable through the closed union above (matches
        // src/telemetry/accounting.ts's applyEvent).
        const exhaustive: never = result
        throw new Error(`installFromHint: unhandled LoadResult outcome ${JSON.stringify(exhaustive)}`)
      }
    }
  })
}
