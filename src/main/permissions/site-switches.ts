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
import { isUnrecordedLocalFile } from '../local-files/local-file-apps.js'
import { grantChangedCapabilities } from '../consent/grant-changed-capabilities.js'

/** The tail of the switches under way for each origin and capability: the next one waits for it. */
const switching = new Map<string, Promise<unknown>>()

/** Runs `move` after every earlier switch of the same capability of the same origin, so two quick presses end as the last one asked. */
function inTurn<T> (origin: string, capability: CapabilityKind, move: () => Promise<T>): Promise<T> {
  const key = `${origin}|${capability}`
  const run = (switching.get(key) ?? Promise.resolve()).then(move, move)
  const tail = run.catch(() => {}).finally(() => { if (switching.get(key) === tail) switching.delete(key) })
  switching.set(key, tail)
  return run
}

/** What `turnOnCapability` actually did, or why it did nothing. */
export type TurnOnResult =
  | 'ok'
  | 'stale' // the manifest changed since the row's patterns were shown; nothing granted.
  | 'not-declared' // the current manifest no longer declares this capability at all.
  | 'not-registered' // no manifest is loaded for this origin this session.

/** What `turnOffCapability` did: `ok`, or why it wrote nothing. */
export type TurnOffResult = Extract<TurnOnResult, 'ok' | 'not-declared' | 'not-registered'>

/**
 * Whether the card has a row for `capability` of `origin`: the app declares it, holds it, or (for an app not opened
 * since Orivon started, known only by its record) holds it or remembers a refusal of it.
 */
async function rowExists (broker: Broker, origin: string, capability: CapabilityKind): Promise<TurnOffResult> {
  if (broker.app.isRegisteredSync(origin)) {
    try {
      const [manifest, grants] = await Promise.all([broker.app.manifest(origin), broker.app.grants(origin)])
      return decideGrantRequest(manifest, capability, undefined).allowed || grants.some((grant) => grant.capability === capability) ? 'ok' : 'not-declared'
    } catch {
      // A manifest that cannot be read this moment: the record on disk still says what is held.
    }
  }
  const persisted = broker.app.persistedAppsSync().find((app) => app.origin === origin)
  if (persisted === undefined) return 'not-registered'
  const declined = (await broker.declinedCapabilitiesFor(origin)) ?? []
  return capability in persisted.grants || declined.includes(capability) ? 'ok' : 'not-declared'
}

/**
 * Revokes `capability` and records the decline, so a later visit does not
 * re-prompt for it (`../../loader/index.js`'s `withoutSwitchedOffCapabilities`
 * reads exactly this record). `recordDeclinedConsent` REPLACES the whole
 * decline set (`../../broker/grants/declined-consent.js`), so this goes
 * through `addDeclinedCapability`'s union rather than writing one directly
 * -- an unrelated capability this origin was already declined for must
 * survive turning a DIFFERENT one off. A decline is written only for a
 * capability the card has a row for, as turning one on already requires.
 */
export function turnOffCapability (broker: Broker, origin: string, capability: CapabilityKind): Promise<TurnOffResult> {
  return inTurn(origin, capability, async () => await turnOff(broker, origin, capability))
}

async function turnOff (broker: Broker, origin: string, capability: CapabilityKind): Promise<TurnOffResult> {
  const known = await rowExists(broker, origin, capability)
  if (known !== 'ok') return known
  await broker.revokePersisted(origin, capability)
  await addDeclinedCapability(broker, origin, capability)
  return 'ok'
}

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
export function turnOnCapability (
  broker: Broker,
  origin: string,
  capability: CapabilityKind,
  shownPatterns: readonly Pattern[]
): Promise<TurnOnResult> {
  return inTurn(origin, capability, async () => await turnOn(broker, origin, capability, shownPatterns))
}

async function turnOn (broker: Broker, origin: string, capability: CapabilityKind, shownPatterns: readonly Pattern[]): Promise<TurnOnResult> {
  if (!broker.app.isRegisteredSync(origin) || isUnrecordedLocalFile(origin)) return 'not-registered'

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
