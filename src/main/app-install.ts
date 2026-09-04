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
 * Wrapped in `withOriginQueue` (A62) so two calls for the same origin --
 * two tabs hitting the same manifest hint near-simultaneously -- never
 * interleave their `Loader.load()` calls into a corrupted on-disk state.
 */
export async function installFromHint (deps: AppInstallDeps, hintedUrl: string): Promise<LoadResult> {
  const origin = originFromUrl(hintedUrl)
  if (origin === null) return { outcome: 'rejected', reason: `hintedUrl is not a valid app origin: ${hintedUrl}` }

  return await withOriginQueue(origin, async () => {
    const [grants, versionFloor] = await Promise.all([
      deps.broker.app.grants(origin),
      deps.broker.versionFloorFor(origin)
    ])

    const result = await deps.loader.load(hintedUrl, {
      grantedPatterns: patternSetFromGrants(grants),
      versionFloor
    })

    if (result.outcome === 'installed') {
      await deps.broker.registerApp(result.canonicalOrigin, result.manifest)
    }
    return result
  })
}
