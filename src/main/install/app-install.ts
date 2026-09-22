// The loader-to-broker glue that has never existed (A60, A61,
// docs/open-questions.md). Builds the one LoadContext Loader.load() needs
// from the broker, then hands whatever it returns to ./update-outcomes.ts's
// driveLoadResult, which owns registerApp/consent and S4-5's three prompts
// for every one of the five outcomes -- see that file's own header. Design
// rationale for the shape of this handoff (why LoadContext is caller-
// supplied, why registerApp may only fire on an accepted install, why
// acknowledgedRollbackVersion passes through unexamined) is in this
// directory's README.md, Design notes -- not repeated here (code-
// guidelines.md Rule 1).

import { originFromUrl } from '../../broker/policy/origin.js'
import { patternSetFromGrants } from '../../broker/policy/update.js'
import type { LoadContext, LoadResult } from '../../loader/index.js'
import { withOriginQueue } from './origin-queue.js'
import { driveLoadResult } from '../consent/update-outcomes.js'
import type { UpdateOutcomeDeps } from '../consent/update-outcomes.js'

/** Everything installFromHint needs, S4-5's three prompts included -- see
 * ./update-outcomes.ts's own doc on why each one is optional and fails
 * closed. Re-exported under this name because every existing caller and
 * test imports `AppInstallDeps` from here, not from ./update-outcomes.js. */
export type AppInstallDeps = UpdateOutcomeDeps

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
 * origin.ts`), already canonical. This seam had to exist from day one, before
 * any real caller did: without it, a hostile page could emit a hint for an
 * unrelated origin (its bank, say) and have this read THAT origin's grants
 * and raise its version floor. `hintedUrl` must resolve to EXACTLY
 * `hintingOrigin` or this rejects before the broker is ever touched, matching
 * `Loader.load()`'s own same-origin contract. The real caller is
 * `src/main/manifest-hint.ts` (S4-2), which derives `hintingOrigin` exactly
 * this way from a `<link rel="orivon-manifest">` hint's sender frame.
 *
 * That same-origin check, and `originFromUrl` failing, both run before any
 * broker call: `GrantLedger.versionFloorFor` creates a permanent in-memory
 * record for any origin it is asked about at all, even a bogus one, so
 * validating first is not optional. What this does NOT run is the full
 * T12/SSRF resolution check `Loader.load()` itself applies internally
 * (`src/loader/install-origin.ts`) -- this function's own check is cheap
 * same-origin validation only, not a substitute for it.
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
    // Read before anything below can register the origin: serving
    // registration (the loader's onInstalled) and registerApp both do.
    const wasRegistered = deps.broker.app.isRegisteredSync(origin)
    const [grants, versionFloor, acknowledgedRollbackVersion] = await Promise.all([
      deps.broker.app.grants(origin),
      deps.broker.versionFloorFor(origin),
      deps.broker.rollbackAcknowledgedVersionFor(origin)
    ])

    const context: LoadContext = { grantedPatterns: patternSetFromGrants(grants), versionFloor, acknowledgedRollbackVersion }
    const result = await deps.loader.load(hintedUrl, context)
    // S4-5: registerApp/consent for an accepted install, and driving each
    // of the other four outcomes to a decision, all live in
    // driveLoadResult -- see ./update-outcomes.ts's own header.
    const driven = await driveLoadResult(deps, result, context)
    if (driven.outcome !== 'installed' || wasRegistered || !deps.broker.app.isRegisteredSync(origin)) return driven
    return { ...driven, newlyRegistered: true }
  })
}
