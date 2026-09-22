// The site-info popover's main page (Chrome-style per-site permissions,
// reworked for Orivon's own capability model). Pure: no broker, no I/O --
// unit-tested directly against real `Manifest`/`Grant` values, the same
// discipline `buildAppPermissions` (./permissions.ts) already follows.
//
// buildAppPermissions is ROW-PER-GRANT: an app with nothing held renders no
// rows at all, which is correct for a revoke-only surface but cannot show a
// switch for something the site asked for and does not currently hold. This
// is ROW-PER-DECLARED-CAPABILITY instead -- the manifest is the source of
// what to show a switch for; whether it is on comes from the live grants.

import type { CapabilityKind, Grant, Manifest, Pattern } from '../../contracts/index.js'
import type { PickedPath } from '../../broker/broker-contracts.js'
import { decideGrantRequest } from '../../broker/policy/request-grant.js'
import { patternSetFromCapabilities } from '../../broker/policy/manifest-patterns.js'
import { describeCapabilityGrant, formatOriginForDisplay } from '../consent/grant-prompt-render.js'
import { describePickedPath } from './permissions.js'
import type { PickedPathRow } from './permissions.js'

export interface SiteCapabilityRow {
  readonly capability: CapabilityKind
  readonly on: boolean
  /**
   * Whether the switch may actually be moved to on. False for a capability
   * the manifest no longer declares as grantable (`decideGrantRequest`
   * refuses it) or, when the row is currently off, for an origin not
   * registered this session -- `site-switches.js`'s `turnOn` needs a live
   * manifest to grant against (`Broker.app.manifest` throws for one that
   * was never registered), the same precondition `requestGrant` already
   * has. A row already ON can always be turned off: revoking never needs a
   * manifest.
   */
  readonly canTurnOn: boolean
  readonly warning: boolean
  readonly message: string
  /**
   * The exact patterns `message` was rendered from -- what is granted
   * today if `on`, or what turning the switch on would grant. Carried so
   * `site-switches.js`'s `turnOn` can re-validate against the manifest at
   * commit time (the same A153 idiom `../consent/request-grant.js` already
   * uses for a live `app.requestGrant` call): the popover can stay open
   * long enough for the manifest to change underneath it.
   */
  readonly patterns: readonly Pattern[]
}

export interface SiteInfo {
  readonly origin: string
  readonly displayOrigin: string
  readonly claimedName: string | undefined
  /** True when the site has asked for at least one Orivon capability or
   * picked a file/folder -- what the toolbar key's visibility switches on. */
  readonly asked: boolean
  readonly capabilityRows: readonly SiteCapabilityRow[]
  readonly pickedPathRows: readonly PickedPathRow[]
}

/**
 * `registered` is `Broker.app.isRegisteredSync(origin)` -- supplied by the
 * caller rather than read here, because this function stays broker-free
 * (this file's own header). It gates `canTurnOn` for an off row only: an
 * ALREADY-HELD capability's `canTurnOn` is always true, matching how a
 * revoke never needs a live manifest either.
 */
export function buildSiteInfo (
  origin: string,
  manifest: Manifest,
  grants: readonly Grant[],
  pickedPaths: readonly PickedPath[],
  registered: boolean
): SiteInfo {
  const heldByCapability = new Map(grants.map((grant): [CapabilityKind, Grant] => [grant.capability, grant]))
  const declared = Object.keys(patternSetFromCapabilities(manifest.capabilities)) as readonly CapabilityKind[]

  const capabilityRows: SiteCapabilityRow[] = []
  for (const capability of declared) {
    const held = heldByCapability.get(capability)
    if (held !== undefined) {
      const { warning, message } = describeCapabilityGrant(capability, held.patterns)
      capabilityRows.push({ capability, on: true, canTurnOn: true, warning, message, patterns: held.patterns })
      continue
    }

    // Not held: what turning this on would grant, under the CURRENT
    // manifest -- never the raw declaration unnarrowed, matching
    // grantChangedCapabilities's own call shape one level up.
    const decision = decideGrantRequest(manifest, capability, undefined)
    if (!decision.allowed) continue // decideGrantRequest fails-closed; nothing to switch.
    const { warning, message } = describeCapabilityGrant(capability, decision.patterns)
    capabilityRows.push({ capability, on: false, canTurnOn: registered, warning, message, patterns: decision.patterns })
  }

  const pickedPathRows = pickedPaths.map((pick): PickedPathRow => {
    const { warning, message } = describePickedPath(pick.kind, pick.path)
    return { pickId: pick.id, warning, message }
  })

  return {
    origin,
    displayOrigin: formatOriginForDisplay(origin),
    claimedName: manifest.name,
    asked: capabilityRows.length > 0 || pickedPathRows.length > 0,
    capabilityRows,
    pickedPathRows
  }
}
