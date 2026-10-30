// The site-info popover's one door to the broker and loader -- mirrors
// ./permissions.ts's own `PermissionsController` (its header: "nothing
// bypasses PermissionsController") for the per-site surface, kept as a
// sibling rather than folded into that file so neither grows into a
// single god-object covering both the grant list and the per-site
// popover (code-guidelines.md Rule 2).

import { NYM_SWITCHED_OFF } from '../route/nym-subsystem.js'
import { profileOrigin, SHARED_ORIGIN, unreadableTunnel } from '../route/route-hub.js'
import { choiceForSwitch } from '../route/tab-tunnel.js'
import type { CapabilityKind, Pattern } from '../../contracts/index.js'
import { isLocalFileKey, isolationKeyFromUrl, originFromUrl } from '../../broker/policy/origin.js'
import type { SubsystemContext } from '../registry.js'
import { buildSiteInfo } from './site-info.js'
import type { BrowserTunnel, SiteInfo, SiteTunnel, SiteTunnelKind, SiteTunnelProfile, SiteUpdate } from './site-info.js'
import { NO_TABS, tabTunnel, tabVia, THIS_TAB } from './site-info-tab.js'
import type { TabTunnels } from './site-info-tab.js'
import { browserTunnel, NO_BROWSER } from './site-info-browser.js'
import type { BrowserTunnels } from './site-info-browser.js'
import { turnOffCapability, turnOnCapability } from './site-switches.js'
import type { TurnOnResult } from './site-switches.js'
import { buildSiteTrust, providerIdFor, withProviderVerdict } from '../browsing/site-trust.js'
import { readHome } from '../browsing/site-home.js'
import { reasonText } from '../../trust/app-update-trust.js'
import type { ApplyOutcome } from '../install/app-updates.js'
import type { DialogCaller } from '../consent/request-grant.js'
import type { SiteTrust } from '../browsing/site-trust.js'
import type { DeliveryLevel, PinCoverageEvidence } from '../../trust/delivery-ladder.js'
import type { ScoreLevel } from '../../trust/website-level.js'
import type { ProviderVerdict } from '../../trust/score-provider.js'
import type { PinRecord } from '../../broker/policy/pin.js'
import type { NameEvidence } from '../verifier/name-evidence.js'
import { canTunnel } from '../route/site-partition.js'
import { isTemporaryRouteSession } from '../route/leaving-routes.js'
import { parseProxyAddress } from '../settings/proxy-checks.js'
import type { ProxyTestReply } from '../route/route-domain.js'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { extensionNamesForOrigin } from '../extensions/site-reach-runner.js'
import type { ExtensionLister } from '../extensions/site-reach-runner.js'

export interface SiteSummary {
  /** What the toolbar key's visibility switches on: true for every ordinary
   * website, whose popover lists what it may do, and for an app that has
   * asked for a capability or picked a file/folder. */
  readonly asked: boolean
  readonly warning: boolean
  /** An app whose permissions are not all granted: a declared capability is switched off, or the app was never let in. The key wears a dot. */
  readonly missing: boolean
}

/** What the controller asks of the first visit (`../install/first-visit.ts`), injected so it never imports it. */
export interface AppEntry {
  /** Why `origin` is an app Orivon was never let into, when it is one. */
  readonly notLetIn: (origin: string) => 'later' | 'declined' | undefined
  /** Gives the first-visit question back for `origin`. */
  readonly askAgain: (origin: string) => Promise<boolean>
  /** Called after a switch of the popup moved, so the key can show or drop its dot. */
  readonly changed: () => void
}

const NO_ENTRY: AppEntry = { notLetIn: () => undefined, askAgain: async () => true, changed: () => {} }

const EMPTY_SITE_INFO = (origin: string, extensionsOnSite: readonly string[] = []): SiteInfo => ({
  origin, displayOrigin: origin, claimedName: undefined, homeDomain: undefined, update: undefined, asked: false, capabilityRows: [], pickedPathRows: [], consentGranularity: 'all-or-nothing', extensionsOnSite
})

/** The loader-adjacent facts `../browsing/site-trust.js` needs but does not
 * read itself (its own header: pure, no `electron-serve.js` import) --
 * `isOriginServedFromCacheSync`/`pinCoverageFor` real implementations live
 * in `../../loader/electron/serve.js`; injected here, defaulted at the
 * real construction site (`../shell/window.ts`), so this controller stays
 * testable against a fake rather than a live Electron session. */
export interface SiteTrustSources {
  readonly isOriginServedFromCacheSync: (origin: string) => boolean
  /** Whether the origin's files are served from its pin; an app served from the verifier before its pin lands is in its own partition but not delivered from a cache. Defaults to `isOriginServedFromCacheSync`. */
  readonly isOriginPinnedSync?: (origin: string) => boolean
  readonly pinCoverageFor: (origin: string) => PinCoverageEvidence | undefined
  /** How a `.eth` name led to this origin's content; undefined for any other origin. */
  readonly nameEvidenceFor: (origin: string, pin: PinRecord | null, servedFromCache: boolean) => Promise<NameEvidence | undefined>
  /** A developer-only Website level override for this origin, or `undefined` (`../dev/score-levels.ts`). */
  readonly levelOverrideFor: (origin: string) => ScoreLevel | undefined
  /** The same, for the Delivery level. */
  readonly deliveryOverrideFor: (origin: string) => DeliveryLevel | undefined
  /** The bundle hash of the DDOC hash tree a local origin serves in developer mode (`../dev/local-ddoc.ts`). */
  readonly localDdocHashFor: (origin: string) => Promise<string | undefined>
  /** The chosen Web3 Score provider's verdict (`../browsing/score-provider-client.ts`). */
  readonly providerVerdictFor: (id: string | undefined, waitMs: number, origin?: string) => Promise<ProviderVerdict>
}

/** How long the popover and shield wait on a provider before showing the lookup as under way. */
const PROVIDER_WAIT_MS = 3_000

export interface StorageDeclaration {
  readonly filesQuotaBytes: number | undefined
  readonly codeVersion: string | undefined
}

/** What the tunnel menu needs of the settings to set the proxy in place; injected so the controller never imports the settings store. */
export interface ProxySetup {
  /** The address saved, '' when none. */
  readonly address: () => string
  /** Saves `text`, as Settings does: refused when the settings hold the choice fixed, invalid when the settings do not take it. */
  readonly save: (text: string) => 'ok' | 'invalid' | 'refused'
  /** Whether the tunnel answers, as Settings' Test asks it. */
  readonly test: (kind: SiteTunnelKind) => Promise<ProxyTestReply>
}

const NO_PROXY_SETUP: ProxySetup = { address: () => '', save: () => 'refused', test: async () => ({ ok: false, reason: 'no-proxy' }) }

export interface SiteInfoController {
  siteSummaryFor: (url: string) => Promise<SiteSummary>
  siteInfoFor: (url: string) => Promise<SiteInfo>
  /** `info` as it is for the tab the popover is about, whose session decides the tunnel of a page opened through an app's tunnel. */
  inSession: (info: SiteInfo, session: object | undefined) => SiteInfo
  /** `info` with the tunnel of the whole browser, for the popup's Browser-wide panel. Left as it is while routes are not running. Apart from `siteInfoFor` because the toolbar asks that on every tab change and has no use for it. */
  withBrowserTunnel: (info: SiteInfo) => SiteInfo
  siteTrustFor: (url: string) => Promise<SiteTrust | null>
  /** What the manifest and the pin declare about storage -- the two facts
   * `../permissions/site-data-runner.js`'s disk measurements need but
   * cannot read themselves (that file stays broker/loader-free). `null`
   * for an unregistered origin: nothing here to declare. */
  storageDeclarationFor: (url: string) => Promise<StorageDeclaration | null>
  /** Takes the update offered for `origin` (`../install/app-updates.ts`): refused for any CID but the pending offer. */
  applyUpdate: (origin: string, cid: string, caller?: DialogCaller) => Promise<ApplyOutcome>
  /** The tunnel popover's facts about the tab `tabId`: the tunnel its websites go through and what it is doing. Undefined for a tab that is not open, and while routes are not running. */
  tabInfoFor: (tabId: string) => SiteInfo | undefined
  /** Gives the tab the tunnel `kind` for every website it opens, or none (null): false when it could not be done (the tab is gone, the tunnel cannot be chosen, the settings cannot be read, a window held to Nym, or the tab could not move to the session the choice calls for). */
  setTabTunnel: (tabId: string, kind: SiteTunnelKind | null) => boolean
  /** Sends a website or an installed app through the tunnel `kind`, or through none (null): false when it could not be done (no address for that tunnel, Nym switched off, this computer, or the choice could not be kept). */
  setTunnel: (origin: string, kind: SiteTunnelKind | null) => Promise<boolean>
  /** Sends the whole browser through the tunnel `kind`, or takes it off its tunnel (null): false when it could not be done (no address for that tunnel, Nym switched off, the settings cannot be read, a window held to Nym). */
  setBrowserTunnel: (kind: SiteTunnelKind | null) => boolean
  /** Whether the IPFS and Swarm nodes follow the tunnel too: false when it could not be done (the settings cannot be read, a window held to Nym). */
  setNodesTunnel: (on: boolean) => boolean
  /** Saves the address of the person's proxy from the menu: refused in a window held to Nym, invalid when it is not host:port. */
  setProxyAddress: (text: string) => 'ok' | 'invalid' | 'refused'
  /** Whether a tunnel answers, as Settings' Test asks it; null in a window held to Nym, which never tests the person's own proxy. */
  testTunnel: (kind: SiteTunnelKind) => Promise<ProxyTestReply | null>
  turnOn: (origin: string, capability: CapabilityKind, shownPatterns: readonly Pattern[]) => Promise<TurnOnResult>
  turnOff: (origin: string, capability: CapabilityKind) => Promise<void>
  revokePickedPath: (origin: string, pickId: string) => Promise<void>
  /** "Delete data" of a local file: its grants, session, saved files and record. False for a key that is not one, or when a step failed. */
  deleteLocalFileData: (key: string) => Promise<boolean>
  /** Gives the first-visit question back for an app that was never let in; false when the origin is not one. */
  reviewPermissions: (origin: string) => Promise<boolean>
}

type Routes = NonNullable<SubsystemContext['routes']>

/** The tunnel the person chose for everything that has no choice of its own: Nym, or their own address (also while none is set). */
function tunnelKindOf (routes: Routes): 'nym' | 'socks5' {
  return routes.defaultKind()
}

/** The person switched Nym off in Settings, so nothing can be sent through it until it is switched on again. */
function nymSwitchedOff (routes: Routes): boolean {
  const nym = routes.nym.state()
  return nym.state === 'unavailable' && nym.reason === NYM_SWITCHED_OFF
}

const TUNNELS: readonly SiteTunnelKind[] = ['nym', 'socks5']

export function createSiteInfoController (ctx: SubsystemContext, trustSources: SiteTrustSources, deleteLocalFile: (key: string) => Promise<boolean> = async () => false, entry: AppEntry = NO_ENTRY, proxySetup: ProxySetup = NO_PROXY_SETUP, tabTunnels: TabTunnels = NO_TABS, browser: BrowserTunnels = NO_BROWSER): SiteInfoController {
  // The extensions disclosure (docs/planning/extensions-exploration.md) -- see
  // README.md's Design notes for why this is computed once, ahead of the
  // registered/unregistered branch `siteInfoFor` makes below.
  async function extensionsFor (origin: string): Promise<readonly string[]> {
    const extensions: ExtensionLister | undefined = ctx.extensions
    if (extensions === undefined) return []
    return await extensionNamesForOrigin(extensions, origin, trustSources.isOriginServedFromCacheSync)
  }

  /** The offer pending for `origin`, in the words the popover shows. */
  function updateFor (origin: string): SiteUpdate | undefined {
    const offer = ctx.appUpdates?.pending(origin)
    if (offer === undefined) return undefined
    return { toCid: offer.toCid, toVersion: offer.toVersion, fromVersion: offer.fromVersion, verified: offer.verified, level: offer.level, reasons: offer.reasons.map((reason) => reasonText(reason, offer.newDomain)) }
  }

  async function siteInfoFor (url: string): Promise<SiteInfo> {
    const info = await builtSiteInfoFor(url)
    const notLetIn = entry.notLetIn(info.origin)
    const update = updateFor(info.origin)
    const route = ctx.routes?.hub.state(info.origin)
    const tunnel = tunnelFor(info.origin)
    // What Nym is doing is asked only for an origin whose route is on and leaves through it.
    const routedKind = route === undefined || route === 'off' ? undefined : ctx.routes?.hub.kindOf(info.origin)
    const nym = routedKind === 'nym' ? ctx.routes?.nym.state() : undefined
    const kind = ctx.routes === undefined ? undefined : routedKind ?? tunnelKindOf(ctx.routes)
    return { ...info, ...(kind === undefined || ctx.routes === undefined ? {} : { tunnelKind: kind, everywhere: ctx.routes.hub.isEverywhere() }), ...(ctx.privateTunnel === 'nym' ? { tunnelHeld: 'nym' as const } : {}), ...(notLetIn === undefined ? {} : { notLetIn }), ...(update === undefined ? {} : { update }), ...(route === undefined || route === 'off' ? {} : { route }), ...(tunnel === undefined ? {} : { tunnel }), ...(nym === undefined ? {} : { nym }) }
  }

  /** The tunnel of the whole browser, for the popup's Browser-wide panel. */
  function browserTunnelFor (routes: Routes): BrowserTunnel {
    const everywhere = routes.hub.isEverywhere()
    const defaultKind = routes.defaultKind()
    const unreadableKind = unreadableTunnel(routes.hub)
    const via = tabVia(undefined, everywhere, defaultKind, unreadableKind)
    const route = via === null ? 'off' : routes.hub.state(unreadableKind === undefined ? SHARED_ORIGIN : profileOrigin(via))
    return browserTunnel({
      everywhere, defaultKind, nodes: browser.nodes(), unreadable: routes.hub.unreadable(), ...(unreadableKind === undefined ? {} : { unreadableKind }),
      blocked: tabBlocked(routes), proxy: { address: proxySetup.address(), users: proxyUsers(routes) }, tabs: browser.tabs(),
      ...(route === 'off' ? {} : { route }), ...(via === 'nym' ? { nym: routes.nym.state() } : {})
    })
  }

  /** The profile the website lives in now. */
  function profileOf (origin: string): { readonly profile?: SiteTunnelProfile } {
    const profile = ctx.routes?.hub.profileFor(origin)
    return profile === undefined ? {} : { profile }
  }

  /** What goes through the person's proxy now: the sites and apps that picked it, and the whole browser when it is on the proxy. */
  function proxyUsers (routes: Routes): SiteTunnel['proxy']['users'] {
    let sites = 0
    let apps = 0
    for (const [origin, entry] of routes.store.entries()) {
      if (entry !== 'socks5') continue
      if (trustSources.isOriginServedFromCacheSync(origin)) apps += 1
      else sites += 1
    }
    return { sites, apps, everything: routes.hub.isEverywhere() && routes.defaultKind() === 'socks5' }
  }

  /** Why each tunnel cannot be chosen for a tab: the proxy has no address, Nym is switched off. */
  function tabBlocked (routes: Routes): SiteTunnel['blocked'] {
    return { ...(routes.targetOf('socks5') === undefined ? { socks5: 'no-proxy' as const } : {}), ...(nymSwitchedOff(routes) ? { nym: 'nym-off' as const } : {}) }
  }

  function tabInfoFor (tabId: string): SiteInfo | undefined {
    const routes = ctx.routes
    const tab = tabTunnels.choiceOf(tabId)
    if (routes === undefined || tab === undefined) return undefined
    const everywhere = routes.hub.isEverywhere()
    const defaultKind = routes.defaultKind()
    // While the settings cannot be read every website is in one tunnel's profile, whatever the tab was told but a tunnel of its own.
    const unreadableKind = unreadableTunnel(routes.hub)
    const via = tabVia(tab.choice, everywhere, defaultKind, unreadableKind)
    // The route the tab's websites share: their tunnel's profile when the tab chose one or the settings cannot be read, the shared one while it follows the browser.
    const route = via === null ? 'off' : routes.hub.state(tab.choice === undefined && unreadableKind === undefined ? SHARED_ORIGIN : profileOrigin(via))
    const tunnel = tabTunnel({ choice: tab.choice, everywhere, defaultKind, unreadable: routes.hub.unreadable(), ...(unreadableKind === undefined ? {} : { unreadableKind }), blocked: tabBlocked(routes), proxy: { address: proxySetup.address(), users: proxyUsers(routes) } })
    return {
      ...EMPTY_SITE_INFO('', []),
      displayOrigin: THIS_TAB,
      tunnelKind: via ?? defaultKind,
      everywhere,
      tunnel,
      ...(ctx.privateTunnel === 'nym' ? { tunnelHeld: 'nym' as const } : {}),
      ...(route === 'off' ? {} : { route }),
      ...(via === 'nym' ? { nym: routes.nym.state() } : {})
    }
  }

  /** The tunnel switches of a website or an installed app; not for a local file or this computer. */
  function tunnelFor (origin: string): SiteTunnel | undefined {
    const routes = ctx.routes
    const subject = trustSources.isOriginServedFromCacheSync(origin) ? 'app' : 'site'
    if (routes === undefined || (subject === 'site' && !canTunnel(origin))) return undefined
    const via = routes.hub.kindOf(origin) ?? null
    const blocked: { -readonly [kind in SiteTunnelKind]?: 'no-proxy' | 'nym-off' | 'not-kept' } = {}
    const notices: { -readonly [choice in SiteTunnelKind | 'off']?: SiteTunnelProfile } = {}
    for (const kind of TUNNELS) {
      const why = routes.routeSwitch.blockedFor(origin, kind)
      if (why === 'no-proxy' || why === 'not-cached') blocked[kind] = why === 'no-proxy' ? 'no-proxy' : 'not-kept'
      if (kind !== via) {
        const moves = routes.routeSwitch.noticeFor(origin, kind)
        if (moves !== undefined) notices[kind] = moves
      }
    }
    if (via !== null) {
      const leaves = routes.routeSwitch.noticeFor(origin, null)
      if (leaves !== undefined) notices.off = leaves
    }
    if (nymSwitchedOff(routes)) blocked.nym = 'nym-off'
    return {
      via,
      following: routes.store.stateOf(origin) === undefined,
      subject,
      blocked,
      notices,
      ...profileOf(origin),
      swarm: BUILTIN_ADDRESSES.servedName(new URL(origin).hostname)?.namespace === 'bzz:',
      unreadable: routes.hub.unreadable(),
      defaultKind: routes.defaultKind(),
      proxy: { address: proxySetup.address(), users: proxyUsers(routes) }
    }
  }

  /**
   * `info` for the tab the popover is about, whose session decides how it goes: a page opened through an app's tunnel (a temporary
   * session) or by an app whose session it was adopted into (a popup) goes through that session's tunnel, whatever its own origin
   * would, and its switches are fixed.
   */
  function inSession (info: SiteInfo, session: object | undefined): SiteInfo {
    const routes = ctx.routes
    if (routes === undefined || session === undefined || info.tunnel === undefined) return info
    const sessionKind = routes.controller.tunnelOf(session)
    if (sessionKind === 'held') return info
    // A page of a tunnelled origin in a session that is not pointed at a tunnel yet (the tab is still moving, or the move failed) is not on its tunnel: it is not shown as if it were.
    if (sessionKind === undefined) return info.tunnel.via === null ? info : { ...info, route: 'moving' }
    const temporary = isTemporaryRouteSession(session)
    if (!temporary && sessionKind === info.tunnel.via) return info
    return { ...info, tunnelKind: sessionKind, route: temporary ? 'temporary' : 'idle', tunnel: { ...info.tunnel, via: sessionKind, following: false, fixed: temporary ? 'temporary' : 'opened', notices: {} }, ...(sessionKind === 'nym' ? { nym: routes.nym.state() } : {}) }
  }

  async function builtSiteInfoFor (url: string): Promise<SiteInfo> {
    // A local file is its own key; every other address is its web origin.
    const origin = isolationKeyFromUrl(url)
    // No canonical origin (about:, chrome://, a malformed url) -- nothing
    // to show, and no address for `broker` to look anything up under.
    if (origin === null) return EMPTY_SITE_INFO(url)
    const extensionsOnSite = await extensionsFor(origin)
    const broker = ctx.broker
    if (broker === undefined || !broker.app.isRegisteredSync(origin)) return EMPTY_SITE_INFO(origin, extensionsOnSite)
    try {
      const [manifest, grants, pickedPaths] = await Promise.all([
        broker.app.manifest(origin),
        broker.app.grants(origin),
        broker.app.pickedPaths(origin)
      ])
      return buildSiteInfo(origin, manifest, grants, pickedPaths, true, trustSources.levelOverrideFor(origin), extensionsOnSite)
    } catch {
      // A registered origin whose manifest read transiently fails -- the
      // same "drop the row rather than throw into a renderer" stance
      // permissions.ts's own describeOrigin takes.
      return EMPTY_SITE_INFO(origin, extensionsOnSite)
    }
  }

  return {
    async siteSummaryFor (url) {
      const info = await siteInfoFor(url)
      return {
        asked: info.asked || /^https?:\/\//.test(info.origin) || isLocalFileKey(info.origin),
        warning: info.capabilityRows.some((r) => r.warning) || info.pickedPathRows.some((r) => r.warning),
        missing: info.notLetIn !== undefined || info.capabilityRows.some((r) => !r.on)
      }
    },

    siteInfoFor,

    inSession,

    withBrowserTunnel (info) {
      return ctx.routes === undefined ? info : { ...info, browserTunnel: browserTunnelFor(ctx.routes) }
    },

    async siteTrustFor (url) {
      const loader = ctx.loader
      const origin = originFromUrl(url)
      if (loader === undefined || origin === null) return null
      const [pin, published] = await Promise.all([loader.pinFor(origin), loader.ddocFor(origin)])
      const servedFromCache = (trustSources.isOriginPinnedSync ?? trustSources.isOriginServedFromCacheSync)(origin)
      const [name, localDevHash] = await Promise.all([
        trustSources.nameEvidenceFor(origin, pin, servedFromCache),
        pin === null ? trustSources.localDdocHashFor(origin) : undefined
      ])
      const trust = buildSiteTrust(
        origin, pin, servedFromCache, trustSources.pinCoverageFor(origin), published, Date.now(), name,
        trustSources.levelOverrideFor(origin), trustSources.deliveryOverrideFor(origin), localDevHash
      )
      const verdict = await trustSources.providerVerdictFor(providerIdFor(trust), PROVIDER_WAIT_MS, origin)
      const home = await readHome(loader, origin, pin, trust.level.assessable?.kind === 'cid' ? name?.content?.cid : undefined, verdict, PROVIDER_WAIT_MS)
      return withProviderVerdict(trust, verdict, home)
    },

    async storageDeclarationFor (url) {
      const origin = isolationKeyFromUrl(url)
      const broker = ctx.broker
      if (origin === null || broker === undefined || !broker.app.isRegisteredSync(origin)) return null
      let manifest
      try {
        manifest = await broker.app.manifest(origin)
      } catch {
        return null
      }
      const pin = ctx.loader === undefined ? null : await ctx.loader.pinFor(origin)
      return { filesQuotaBytes: manifest.capabilities.fs?.quotaBytes, codeVersion: pin?.version }
    },

    async applyUpdate (origin, cid, caller) {
      const updates = ctx.appUpdates
      return updates === undefined ? { ok: false, reason: 'no such offer' } : await updates.apply(origin, cid, caller)
    },

    setProxyAddress (text) {
      if (ctx.routes === undefined || ctx.privateTunnel === 'nym') return 'refused'
      const address = text.trim()
      return address.length > 300 || parseProxyAddress(address) === undefined ? 'invalid' : proxySetup.save(address)
    },

    async testTunnel (kind) {
      return ctx.routes === undefined || ctx.privateTunnel === 'nym' ? null : await proxySetup.test(kind)
    },

    tabInfoFor,

    setTabTunnel (tabId, kind) {
      const routes = ctx.routes
      if (routes === undefined || tabTunnels.choiceOf(tabId) === undefined || routes.hub.unreadable()) return false
      // A window held to Nym keeps every switch where it is (the tab refuses any other choice too).
      if (ctx.privateTunnel === 'nym' && kind !== 'nym') return false
      if (kind !== null && (routes.targetOf(kind) === undefined || (kind === 'nym' && nymSwitchedOff(routes)))) return false
      const choice = choiceForSwitch(kind, routes.hub.isEverywhere())
      tabTunnels.set(tabId, choice)
      return tabTunnels.choiceOf(tabId)?.choice === (choice ?? undefined)
    },

    async setTunnel (origin, kind) {
      const routes = ctx.routes
      if (routes === undefined || (!trustSources.isOriginServedFromCacheSync(origin) && !canTunnel(origin))) return false
      // A window held to Nym keeps every switch where it is (the store refuses it too).
      if (ctx.privateTunnel === 'nym' && kind !== 'nym') return false
      if (kind !== null && (routes.routeSwitch.blockedFor(origin, kind) !== undefined || (kind === 'nym' && nymSwitchedOff(routes)))) return false
      try {
        await routes.routeSwitch.choose(origin, kind)
      } catch (error) {
        console.error('[site-info] the tunnel of a website could not be switched:', error)
        return false
      }
      return true
    },

    setBrowserTunnel (kind) {
      const routes = ctx.routes
      // A window held to Nym keeps every setting where it is, whatever the popup asks (the store refuses it too).
      if (routes === undefined || ctx.privateTunnel === 'nym' || routes.hub.unreadable()) return false
      if (kind === null) return browser.setEverywhere(false)
      if (tabBlocked(routes)[kind] !== undefined) return false
      // The tunnel first: the routes then never see the whole browser switched on with the old one.
      return browser.setKind(kind) && browser.setEverywhere(true)
    },

    setNodesTunnel (on) {
      const routes = ctx.routes
      if (routes === undefined || ctx.privateTunnel === 'nym' || routes.hub.unreadable()) return false
      return browser.setNodes(on)
    },

    async turnOn (origin, capability, shownPatterns) {
      const broker = ctx.broker
      if (broker === undefined) return 'not-registered'
      const result = await turnOnCapability(broker, origin, capability, shownPatterns)
      entry.changed()
      return result
    },

    async turnOff (origin, capability) {
      const broker = ctx.broker
      if (broker === undefined) return
      if (await turnOffCapability(broker, origin, capability) === 'ok') entry.changed()
    },

    async revokePickedPath (origin, pickId) {
      const broker = ctx.broker
      if (broker === undefined) return
      await broker.revokeUserSelectedPath(origin, pickId)
    },

    async deleteLocalFileData (key) {
      return isLocalFileKey(key) ? await deleteLocalFile(key) : false
    },

    async reviewPermissions (origin) {
      if (entry.notLetIn(origin) === undefined) return false
      return await entry.askAgain(origin)
    }
  }
}
