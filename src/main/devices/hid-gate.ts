// The gate a page's WebHID calls pass (ADR-0068): may this origin use `navigator.hid` at all, is this device usable by
// it, and which devices does the chooser offer. It remembers only what the person declined this session; what they
// approved is in `HidApprovals`. Pure over its dependencies: no `electron`.
import type { Pattern } from '../../contracts/index.js'
import { decideHid, matchesAny, filtersFromPatterns, type HidDecision, type HidDeviceInfo, type HidParty, deviceKey } from './hid-policy.js'

export interface HidGateDeps {
  readonly approvals: { has: (origin: string, key: string) => boolean }
  /** A registered app's origin, with or without a grant. */
  readonly isApp: (origin: string) => boolean
  /** The app's `devices.hid` patterns, or undefined when it holds none. */
  readonly appPatterns: (origin: string) => readonly Pattern[] | undefined
  /** The person's Block for "USB and HID devices" applies to this website. */
  readonly siteBlocked: (origin: string) => boolean
  /** Opens the question "connect this device to this app?"; the asker keeps it to one open question per origin and device. */
  readonly requestAsk: (origin: string, device: HidDeviceInfo) => void
}

export interface HidGate {
  /** The permission check for `hid`: false stops `requestDevice` and every device from reaching the page. */
  mayUse: (origin: string) => boolean
  decide: (origin: string, device: HidDeviceInfo) => HidDecision
  /** The device permission handler: true only for an approved device the origin may use; a matching app device not yet decided starts the question. */
  devicePermission: (origin: string, device: HidDeviceInfo) => boolean
  /** "Not now": the device is not asked about again for this origin until the browser restarts. */
  decline: (origin: string, device: HidDeviceInfo) => void
  /** The devices the chooser lists, or null when no chooser may open (a blocked website, an app without the grant). */
  chooserDevices: (origin: string, listed: readonly HidDeviceInfo[]) => HidDeviceInfo[] | null
}

export function createHidGate (deps: HidGateDeps): HidGate {
  const declined = new Set<string>()
  const declinedKey = (origin: string, device: HidDeviceInfo): string => `${origin}\n${deviceKey(device)}`

  const partyOf = (origin: string): HidParty => deps.isApp(origin)
    ? { kind: 'app', patterns: deps.appPatterns(origin) }
    : { kind: 'website', blocked: deps.siteBlocked(origin) }

  function decide (origin: string, device: HidDeviceInfo): HidDecision {
    return decideHid({
      party: partyOf(origin),
      device,
      approved: deps.approvals.has(origin, deviceKey(device)),
      declined: declined.has(declinedKey(origin, device))
    })
  }

  return {
    mayUse (origin) {
      const party = partyOf(origin)
      return party.kind === 'app' ? party.patterns !== undefined : !party.blocked
    },
    decide,
    devicePermission (origin, device) {
      const decision = decide(origin, device)
      if (decision === 'ask') deps.requestAsk(origin, device)
      return decision === 'allow'
    },
    decline (origin, device) {
      declined.add(declinedKey(origin, device))
    },
    chooserDevices (origin, listed) {
      const party = partyOf(origin)
      if (party.kind === 'website') return party.blocked ? null : [...listed]
      if (party.patterns === undefined) return null
      const filters = filtersFromPatterns(party.patterns)
      return listed.filter((device) => matchesAny(device, filters))
    }
  }
}
