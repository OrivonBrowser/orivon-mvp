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
// F3 (fleet run review-72-76): both PR #72 and `rollback-ack` are merged, so
// this now wires for real. `LoadContext.acknowledgedRollbackVersion` (#72)
// takes the RAW value `Broker.rollbackAcknowledgedVersionFor` (rollback-ack)
// returns -- a version string or `undefined` -- not a boolean this function
// would have to compute itself. That is deliberate: this function cannot
// know which version `Loader.load()` is about to offer until `load()` has
// already fetched the manifest, so it hands over the acknowledged version
// unexamined and lets `load()` do the exact-match comparison once it
// actually knows. See `LoadContext`'s own doc (`src/loader/index.ts`) for
// why an origin-only "has this origin ever been acknowledged" check would
// reopen the exact flaw `rollback-ack`'s version-keyed storage closed.

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
 * verbatim from `broker.versionFloorFor(origin)`, `acknowledgedRollbackVersion`
 * verbatim from `broker.rollbackAcknowledgedVersionFor(origin)`) and
 * everything the broker needs back once `load()` decides (`registerApp`,
 * A60's timing rule above).
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
 * full T12/SSRF resolution check `Loader.load()` itself applies internally
 * (`src/loader/install-origin.ts`) -- this function's own check is cheap
 * same-origin validation only, not a substitute for it; see this lane's PR
 * body for why duplicating that check here was rejected.
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
    const [grants, versionFloor, acknowledgedRollbackVersion] = await Promise.all([
      deps.broker.app.grants(origin),
      deps.broker.versionFloorFor(origin),
      deps.broker.rollbackAcknowledgedVersionFor(origin)
    ])

    const result = await deps.loader.load(hintedUrl, {
      grantedPatterns: patternSetFromGrants(grants),
      versionFloor,
      acknowledgedRollbackVersion
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
      case 'needs-rollback-choice':
      case 'rejected':
        // A60: registerApp fires only on an accepted install, never here --
        // returned exactly as loader.load() produced it. A caller that
        // drives the 'needs-rollback-choice' prompt to acceptance is
        // expected to call broker.acknowledgeRollback(origin, version)
        // itself, then call installFromHint again -- not this function's
        // job (no UI exists yet to make that choice).
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
