// The tunnel popup opened for a tab (ADR-0101, ADR-0104): what the tab shows, and the commands that set the tab's choice and the
// "Always" switch that makes it the website's own. A sibling of `site-info-controller.ts`, which hands it the facts of a website's
// own panel; the choices and entries it changes go through the same calls the other switches use (`tabTunnels.set`, `routeSwitch`).

import { originFromUrl } from '../../broker/policy/origin.js'
import { formatOriginForDisplay } from '../consent/grant-prompt-render.js'
import { NYM_SWITCHED_OFF } from '../route/nym-subsystem.js'
import { profileOrigin, SHARED_ORIGIN, unreadableTunnel } from '../route/route-hub.js'
import { planAlwaysOff, planAlwaysOn, planMove, tabKeepsSession } from '../route/site-always.js'
import type { AlwaysFacts, RoutePlan } from '../route/site-always.js'
import { canTunnel } from '../route/site-partition.js'
import { tunnelOfPage } from '../route/tab-tunnel.js'
import type { SubsystemContext } from '../registry.js'
import { emptySiteInfo } from './site-info.js'
import type { SiteInfo, SiteTunnel, SiteTunnelKind } from './site-info.js'
import { tabSiteTunnel, tabTunnel, tabVia, THIS_TAB } from './site-info-tab.js'
import type { TabTunnels } from './site-info-tab.js'

type Routes = NonNullable<SubsystemContext['routes']>

/** The person switched Nym off in Settings, so nothing can be sent through it until it is switched on again. */
export function nymSwitchedOff (routes: Routes): boolean {
  const nym = routes.nym.state()
  return nym.state === 'unavailable' && nym.reason === NYM_SWITCHED_OFF
}

/** What the tab popup's controller reads of the rest of the site-info controller, injected so neither imports the other. */
export interface TabControllerParts {
  readonly ctx: SubsystemContext
  readonly tabTunnels: TabTunnels
  /** Whether `origin` is an installed app, which keeps its own route whatever a tab carries. */
  readonly isApp: (origin: string) => boolean
  /** The website's own panel for `origin` with the tunnel `lit` lit: why a tunnel cannot be chosen, the storage notices, Swarm. */
  readonly websiteTunnel: (origin: string, lit: SiteTunnelKind | null) => SiteTunnel | undefined
  readonly blocked: (routes: Routes) => SiteTunnel['blocked']
  readonly proxy: (routes: Routes) => SiteTunnel['proxy']
  readonly extensionsFor: (origin: string) => Promise<readonly string[]>
  /** Sends a website through the tunnel `kind` (null: none) as its own panel's switch does: false when it could not be done. */
  readonly setWebsiteTunnel: (origin: string, kind: SiteTunnelKind | null) => Promise<boolean>
}

export interface TabTunnelController {
  tabInfoFor: (tabId: string) => Promise<SiteInfo | undefined>
  /** The origin of the website the popup for `tabId` is about, or '' when it is about no website. */
  tabShownOrigin: (tabId: string) => string
  setTabTunnel: (tabId: string, kind: SiteTunnelKind | null, shownOrigin?: string) => Promise<boolean>
  setSiteAlways: (tabId: string, on: boolean, shownOrigin: string) => Promise<boolean>
}

export function createTabTunnelController (parts: TabControllerParts): TabTunnelController {
  const { ctx, tabTunnels } = parts

  /** The website a tab shows, or is opening: a web origin that can go through a tunnel and is no installed app. */
  function websiteOf (address: string | undefined): string | undefined {
    const origin = address === undefined ? null : originFromUrl(address)
    return origin !== null && canTunnel(origin) && !parts.isApp(origin) ? origin : undefined
  }

  async function tabInfoFor (tabId: string): Promise<SiteInfo | undefined> {
    const routes = ctx.routes
    const tab = tabTunnels.choiceOf(tabId)
    if (routes === undefined || tab === undefined) return undefined
    const everywhere = routes.hub.isEverywhere()
    const defaultKind = routes.defaultKind()
    // While the settings cannot be read every website is in one tunnel's profile, whatever the tab was told but a tunnel of its own.
    const unreadableKind = unreadableTunnel(routes.hub)
    const origin = websiteOf(tab.address)
    const entry = origin === undefined ? undefined : routes.store.stateOf(origin)
    const browser = tabVia(undefined, everywhere, defaultKind, unreadableKind) ?? undefined
    const ownProfile = origin === undefined ? undefined : routes.hub.profileFor(origin)
    const via = origin === undefined ? tabVia(tab.choice, everywhere, defaultKind, unreadableKind) : tunnelOfPage(tab.choice, origin, ownProfile, browser) ?? null
    const site = origin === undefined ? undefined : parts.websiteTunnel(origin, via)
    const tunnel = origin === undefined || site === undefined
      ? tabTunnel({ choice: tab.choice, everywhere, defaultKind, unreadable: routes.hub.unreadable(), ...(unreadableKind === undefined ? {} : { unreadableKind }), blocked: parts.blocked(routes), proxy: parts.proxy(routes) })
      : tabSiteTunnel({ origin, choice: tab.choice, entry, ownProfile, everywhere, ...(unreadableKind === undefined ? {} : { unreadableKind }), site })
    // The route the page shares: its tunnel's profile when the tab chose one or the settings cannot be read, the website's own or the shared one while it follows.
    const followsOwn = tab.choice === undefined && unreadableKind === undefined
    const route = via === null ? 'off' : routes.hub.state(followsOwn ? origin ?? SHARED_ORIGIN : profileOrigin(via))
    const extensions = origin === undefined || site === undefined ? [] : await parts.extensionsFor(origin)
    return {
      ...emptySiteInfo(site === undefined || origin === undefined ? '' : origin, extensions),
      // A tab on a website names it under the title, as the website's own panel did; the tab alone has no name to give.
      displayOrigin: site === undefined || origin === undefined ? THIS_TAB : formatOriginForDisplay(origin),
      tunnelKind: via ?? defaultKind,
      everywhere,
      tunnel,
      ...(ctx.privateTunnel === 'nym' ? { tunnelHeld: 'nym' as const } : {}),
      ...(route === 'off' ? {} : { route }),
      ...(via === 'nym' ? { nym: routes.nym.state() } : {})
    }
  }

  function tabShownOrigin (tabId: string): string {
    return websiteOf(tabTunnels.choiceOf(tabId)?.address) ?? ''
  }

  /**
   * Carries out a plan: the tab first, because moving it is what can fail, then the website's entry. An entry that could not be
   * changed at all gives the tab back what it had; one that changed before the failure keeps the tab where the plan put it, so
   * the page and the entry agree, and the answer is still a failure for the panel to redraw from what is true.
   */
  async function carryOut (tabId: string, origin: string | undefined, plan: RoutePlan, facts: AlwaysFacts): Promise<boolean> {
    const routes = ctx.routes
    if (routes === undefined || (plan.entry !== undefined && origin === undefined)) return false
    if (plan.tab !== undefined) {
      tabTunnels.set(tabId, plan.tab)
      if (tabTunnels.choiceOf(tabId)?.choice !== (plan.tab ?? undefined)) return false
    }
    if (plan.entry !== undefined && origin !== undefined) {
      const after = plan.tab === undefined ? facts.choice : (plan.tab ?? undefined)
      const done = plan.entry === 'forget' ? await forgetEntry(routes, origin, tabKeepsSession(after, facts.entry)) : await parts.setWebsiteTunnel(origin, plan.entry.choose)
      if (!done) {
        if (plan.tab !== undefined && routes.store.stateOf(origin) === facts.entry) tabTunnels.set(tabId, facts.choice ?? null)
        return false
      }
    }
    return true
  }

  async function forgetEntry (routes: Routes, origin: string, tabStays: boolean): Promise<boolean> {
    try {
      await routes.routeSwitch.forget(origin, tabStays)
      return true
    } catch (error) {
      console.error('[site-info] the tunnel of a website could not be taken away:', error)
      return false
    }
  }

  /** A tunnel can be chosen: the settings can be read, the window is not held to another tunnel, the tunnel has an address and Nym is not switched off. */
  function mayChoose (routes: Routes, kind: SiteTunnelKind | null): boolean {
    if (routes.hub.unreadable()) return false
    // A window held to Nym keeps every switch where it is (the tab refuses any other choice too).
    if (ctx.privateTunnel === 'nym' && kind !== 'nym') return false
    return kind === null || (routes.targetOf(kind) !== undefined && !(kind === 'nym' && nymSwitchedOff(routes)))
  }

  /** What the command acts on, read from the tab now: its choice and the website it shows with that website's entry. */
  function actingOn (routes: Routes, tabId: string): { readonly origin: string | undefined, readonly facts: AlwaysFacts } | undefined {
    const tab = tabTunnels.choiceOf(tabId)
    if (tab === undefined) return undefined
    const origin = websiteOf(tab.address)
    const entry = origin === undefined ? undefined : routes.store.stateOf(origin)
    return { origin, facts: { choice: tab.choice, entry, everywhere: routes.hub.isEverywhere() } }
  }

  async function setTabTunnel (tabId: string, kind: SiteTunnelKind | null, shownOrigin = ''): Promise<boolean> {
    const routes = ctx.routes
    if (routes === undefined || !mayChoose(routes, kind)) return false
    const now = actingOn(routes, tabId)
    if (now === undefined) return false
    // The popup stays open across a navigation: a move that would change the entry of a website the person was not shown fails closed.
    if (now.facts.entry !== undefined && shownOrigin !== now.origin) return false
    return await carryOut(tabId, now.origin, planMove(now.facts, kind), now.facts)
  }

  async function setSiteAlways (tabId: string, on: boolean, shownOrigin: string): Promise<boolean> {
    const routes = ctx.routes
    // Entries are made from the website's own panel and the tab's: not while the settings cannot be read, and not in a window held to Nym.
    if (routes === undefined || routes.hub.unreadable() || ctx.privateTunnel === 'nym') return false
    const now = actingOn(routes, tabId)
    if (now?.origin === undefined || shownOrigin !== now.origin) return false
    // Already as asked: nothing to do, and nothing wrong.
    if (on === (now.facts.entry !== undefined)) return true
    const plan = on ? planAlwaysOn(now.facts) : planAlwaysOff(now.facts)
    return plan !== undefined && await carryOut(tabId, now.origin, plan, now.facts)
  }

  return { tabInfoFor, tabShownOrigin, setTabTunnel, setSiteAlways }
}
