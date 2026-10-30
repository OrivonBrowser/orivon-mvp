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

import type { NymState } from '../route/nym-status.js'
import type { TabTunnelChoice } from '../route/tab-tunnel.js'
import type { CapabilityKind, ConsentGranularity, Grant, Manifest, Pattern } from '../../contracts/index.js'
import type { PickedPath } from '../../broker/broker-contracts.js'
import { offerCapability } from '../consent/capability-row.js'
import { patternSetFromCapabilities } from '../../broker/policy/manifest-patterns.js'
import { describeCapabilityGrant, formatOriginForDisplay } from '../consent/grant-prompt-render.js'
import { summaryAtLevel } from '../consent/grant-level.js'
import { describePickedPath } from './permissions.js'
import type { PickedPathRow } from './permissions.js'
import type { ScoreLevel } from '../../trust/website-level.js'

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

/** A newer version of an installed app, offered because its name moved: what the popover shows and offers to take. */
export interface SiteUpdate {
  readonly toCid: string
  readonly toVersion: string
  readonly fromVersion: string | undefined
  /** Verified offers are taken with Update; any other needs Trust & Force. */
  readonly verified: boolean
  readonly level: number | undefined
  /** Why a version is not verified, one sentence each. */
  readonly reasons: readonly string[]
}

/** What a routed app's route is doing, as the popover says it. An app that is not routed has none. `temporary` is a website opened through the proxy from a routed app: its session holds nothing past its last tab. */
export type SiteRoute = 'idle' | 'ok' | 'down' | 'no-proxy' | 'temporary' | 'moving'

/** A tunnel a website or an installed app can be sent through. */
export type SiteTunnelKind = 'nym' | 'socks5'

/**
 * What the popover shows for the tunnel of a website or an installed app, which is chosen the same way for both. `via` is the
 * tunnel it goes through now; `following` says it has no choice of its own and goes where the browser's default sends it.
 * `swarm` marks an address read from the Swarm node Orivon runs, which cannot be sent through a tunnel, so the address does not
 * open while a tunnel is on for it; `unreadable` that the list of tunnel settings could not be read, so every site is on and the
 * choice is fixed.
 */
/** A profile a website lives in: Nym's, the person's proxy's, or the direct one. */
export type SiteTunnelProfile = SiteTunnelKind | 'direct'

export interface SiteTunnel {
  readonly via: SiteTunnelKind | null
  readonly following: boolean
  /** Whose tunnel the popover is about: an installed app, a website, or a tab (every website opened in it, ADR-0101). */
  readonly subject: 'app' | 'site' | 'tab'
  /** Why each tunnel cannot be chosen now (a tunnel can always be given up). */
  readonly blocked: Readonly<Partial<Record<SiteTunnelKind, 'no-proxy' | 'nym-off' | 'not-kept'>>>
  /** The profile each choice would move a website into for the first time, so the person is told first. `off` is the choice of no tunnel. Never set for an app. */
  readonly notices: Readonly<Partial<Record<SiteTunnelKind | 'off', SiteTunnelProfile>>>
  readonly swarm: boolean
  readonly unreadable: boolean
  /** The profile the website lives in now, when its entry puts it in one. */
  readonly profile?: SiteTunnelProfile
  /** The tunnel everything without a choice of its own goes through. */
  readonly defaultKind: SiteTunnelKind
  /** The person's own proxy: the address saved ('' when none), and what goes through it now, so a change of address can say who it moves. */
  readonly proxy: { readonly address: string, readonly users: { readonly sites: number, readonly apps: number, readonly everything: boolean } }
  /** For a tab: the choice it carries; absent for a tab with none, whose websites follow their own entries. */
  readonly tabChoice?: TabTunnelChoice
  /** The page does not choose its tunnel here: it runs in a temporary session opened through an app's tunnel, or in the session of the app that opened it. */
  readonly fixed?: 'temporary' | 'opened'
}

/** A tab that carries a tunnel choice of its own: the words that name it (its title, else its address) and what it keeps. */
export interface BrowserTunnelTab {
  readonly title: string
  readonly choice: TabTunnelChoice
}

/**
 * What the Browser-wide panel of the tunnels popup shows: the tunnel the whole browser goes through (`via`, null while it is
 * not on one), whether the IPFS and Swarm nodes follow it, why a tunnel cannot be chosen, the person's proxy, whether the settings
 * could not be read, and every tab in every window that keeps a choice of its own whatever is set here.
 */
export interface BrowserTunnel {
  readonly via: SiteTunnelKind | null
  readonly defaultKind: SiteTunnelKind
  readonly nodes: boolean
  readonly blocked: SiteTunnel['blocked']
  readonly proxy: SiteTunnel['proxy']
  readonly unreadable: boolean
  readonly tabs: readonly BrowserTunnelTab[]
  /** What the shared route of the browser is doing; absent while it is not on a tunnel. */
  readonly route?: SiteRoute
  /** What Nym is doing, while the browser goes through it. */
  readonly nym?: NymState
}

export interface SiteInfo {
  readonly origin: string
  readonly displayOrigin: string
  readonly claimedName: string | undefined
  /** The `domain` the app's manifest names as its home, when it names one. */
  readonly homeDomain: string | undefined
  /** Where the manifest says a problem with the app is reported (`Manifest.support`): an `https://` address. Absent when it names none. */
  readonly supportIssues?: string
  /** The update offered to this installed app, when its name has moved. */
  readonly update: SiteUpdate | undefined
  /** The state of the app's route when the person routed it through their proxy (`../route/`). */
  readonly route?: SiteRoute
  /** What Nym is doing, when the app's route leaves through it. */
  readonly nym?: NymState
  /** Which tunnel the person's choice sends traffic through: Nym, or their own SOCKS5 address. Absent while routes are not running. */
  readonly tunnelKind?: 'nym' | 'socks5'
  /** The whole browser goes through the tunnel unless a site is set to off. Absent while routes are not running. */
  readonly everywhere?: boolean
  /** This is a private window held to a tunnel for its whole life: every switch is on and fixed. Absent otherwise. */
  readonly tunnelHeld?: 'nym'
  /** The tunnel switch of a website; absent for an installed app, a local file and this computer. */
  readonly tunnel?: SiteTunnel
  /** The tunnel of the whole browser, for the Browser-wide panel. Absent while routes are not running. */
  readonly browserTunnel?: BrowserTunnel
  /** True when the site has asked for at least one Orivon capability or
   * picked a file/folder -- what the toolbar key's visibility switches on. */
  readonly asked: boolean
  readonly capabilityRows: readonly SiteCapabilityRow[]
  readonly pickedPathRows: readonly PickedPathRow[]
  /**
   * `manifest.consentGranularity`, with the contract's own "omitted means
   * `'all-or-nothing'`" applied here rather than left for a renderer to
   * remember -- the popup's staged-footer warning ("this app asked for
   * these together") only makes sense for an all-or-nothing app.
   */
  readonly consentGranularity: ConsentGranularity
  /**
   * Names of enabled installed extensions whose host access covers this
   * origin (the extensions disclosure, docs/planning/extensions-exploration.md) --
   * plain pass-through, never computed here: only the caller
   * (site-info-controller.ts) has `ctx.extensions`, so this file stays
   * broker/I/O-free (this file's own header) and just carries the value
   * through to `SiteInfo`. Empty by default, so every pre-existing caller
   * of `buildSiteInfo` here and in tests keeps building the same shape.
   */
  readonly extensionsOnSite: readonly string[]
  /** Set for an app Orivon was never let into -- its first-visit question was dismissed (`later`) or closed with nothing switched on (`declined`) -- so the popup can offer the question back. */
  readonly notLetIn?: 'later' | 'declined'
}

/**
 * `registered` is `Broker.app.isRegisteredSync(origin)` -- supplied by the
 * caller rather than read here, because this function stays broker-free
 * (this file's own header). It gates `canTurnOn` for an off row only: an
 * ALREADY-HELD capability's `canTurnOn` is always true, matching how a
 * revoke never needs a live manifest either.
 *
 * `level` (ADR-0037), when this origin is displayed at Level 4, strips
 * every row's warning through `summaryAtLevel` -- an off row (what turning
 * the switch on would grant) and an on row alike.
 */
export function buildSiteInfo (
  origin: string,
  manifest: Manifest,
  grants: readonly Grant[],
  pickedPaths: readonly PickedPath[],
  registered: boolean,
  level?: ScoreLevel,
  extensionsOnSite: readonly string[] = []
): SiteInfo {
  const heldByCapability = new Map(grants.map((grant): [CapabilityKind, Grant] => [grant.capability, grant]))
  const declared = Object.keys(patternSetFromCapabilities(manifest.capabilities)) as readonly CapabilityKind[]

  const capabilityRows: SiteCapabilityRow[] = []
  for (const capability of declared) {
    const held = heldByCapability.get(capability)
    if (held !== undefined) {
      const { warning, message } = summaryAtLevel(describeCapabilityGrant(capability, held.patterns), level)
      capabilityRows.push({ capability, on: true, canTurnOn: true, warning, message, patterns: held.patterns })
      continue
    }

    // Not held: what turning this on would grant, under the CURRENT manifest -- never the raw declaration unnarrowed.
    const offered = offerCapability(manifest, capability, level)
    if (offered === undefined) continue // decideGrantRequest fails-closed; nothing to switch.
    capabilityRows.push({ capability, on: false, canTurnOn: registered, warning: offered.warning, message: offered.message, patterns: offered.patterns })
  }

  const pickedPathRows = pickedPaths.map((pick): PickedPathRow => {
    const { warning, message } = summaryAtLevel(describePickedPath(pick.kind, pick.path), level)
    return { pickId: pick.id, kind: pick.kind, warning, message }
  })

  return {
    origin,
    displayOrigin: formatOriginForDisplay(origin),
    claimedName: manifest.name,
    homeDomain: manifest.domain,
    ...(manifest.support === undefined ? {} : { supportIssues: manifest.support.issues }),
    update: undefined,
    asked: capabilityRows.length > 0 || pickedPathRows.length > 0,
    capabilityRows,
    pickedPathRows,
    consentGranularity: manifest.consentGranularity ?? 'all-or-nothing',
    extensionsOnSite
  }
}
