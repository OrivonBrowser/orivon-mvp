// The site-info popover's own switches -- "off" and "on" for one declared
// capability at a time, called from ./site-info-ipc.ts's `apply` command
// (never bypassed: this is the one door, matching ./permissions.ts's own
// PermissionsController rule). Broker-shaped but stateless, same idiom as
// ../consent/request-grant.ts, which this reuses rather than duplicates.

import { decideGrantRequest } from '../../broker/policy/request-grant.js'
import { sameOwnPatterns } from '../../broker/policy/update.js'
import type { Broker } from '../../broker/broker-contracts.js'
import type { CapabilityKind, Pattern } from '../../contracts/index.js'
import { addDeclinedCapability, clearDeclinedCapability } from '../consent/request-grant.js'
import { grantChangedCapabilities } from '../consent/grant-changed-capabilities.js'

/**
 * Revokes `capability` and records the decline, so a later visit does not
 * re-prompt for it (`../../loader/index.js`'s `withoutSwitchedOffCapabilities`
 * reads exactly this record). `recordDeclinedConsent` REPLACES the whole
 * decline set (`../../broker/grants/declined-consent.js`), so this goes
 * through `addDeclinedCapability`'s union rather than writing one directly
 * -- an unrelated capability this origin was already declined for must
 * survive turning a DIFFERENT one off.
 */
export async function turnOffCapability (broker: Broker, origin: string, capability: CapabilityKind): Promise<void> {
  await broker.revokePersisted(origin, capability)
  await addDeclinedCapability(broker, origin, capability)
}

/** What `turnOnCapability` actually did, or why it did nothing. */
export type TurnOnResult =
  | 'ok'
  | 'stale' // the manifest changed since the row's patterns were shown; nothing granted.
  | 'not-declared' // the current manifest no longer declares this capability at all.
  | 'not-registered' // no manifest is loaded for this origin this session.

/**
 * Grants `capability`, bounded to the CURRENT manifest's own declared
 * patterns -- never `shownPatterns` passed through, even on a match --
 * matching `grantChangedCapabilities`'s own "never a raw pass-through"
 * rule one layer down. `shownPatterns` exists only to CATCH a race, the
 * same A153 hazard `../consent/request-grant.js`'s own `requestGrant`
 * already guards against: the popover can sit open, showing what a
 * capability would grant, for long enough that a reload re-registers a
 * narrower -- or wider -- manifest underneath it. Silently granting
 * whatever the manifest says NOW would let the person confirm something
 * they were never shown; failing closed and returning `'stale'` instead
 * lets the caller re-read `site-info.js`'s fresh rows and redraw before
 * asking again.
 */
export async function turnOnCapability (
  broker: Broker,
  origin: string,
  capability: CapabilityKind,
  shownPatterns: readonly Pattern[]
): Promise<TurnOnResult> {
  if (!broker.app.isRegisteredSync(origin)) return 'not-registered'

  let manifest
  try {
    manifest = await broker.app.manifest(origin)
  } catch {
    return 'not-registered'
  }

  const decision = decideGrantRequest(manifest, capability, undefined)
  if (!decision.allowed) return 'not-declared'
  if (!sameOwnPatterns(decision.patterns, shownPatterns)) return 'stale'

  // Cleared BEFORE granting, same ordering as ../consent/request-grant.ts's
  // own accept path: grantChangedCapabilities swallows a per-capability
  // failure (its own doc), so acting after could leave a capability that
  // failed to grant still covered by a now-stale decline.
  await clearDeclinedCapability(broker, origin, capability)
  await grantChangedCapabilities(broker, origin, manifest, [capability])
  return 'ok'
}
