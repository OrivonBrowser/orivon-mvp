// The tunnel popover when it is about a tab, not a website: every website the tab opens goes through the tunnel the tab
// carries (`../route/tab-tunnel.ts`, ADR-0101). Pure: the controller reads the routes and the tabs, this builds what the
// popover shows from what it read.

import { profileForTab, tabWebsitesTunnel, tunnelOfPage } from '../route/tab-tunnel.js'
import type { TabTunnelChoice } from '../route/tab-tunnel.js'
import { alwaysState } from '../route/site-always.js'
import type { Profile } from '../route/site-partition.js'
import type { TunnelEntry } from '../route/route-state.js'
import type { SiteTunnel, SiteTunnelKind } from './site-info.js'

/** What the popover calls the subject of a tab's tunnel, where it names a site's origin for a website. */
export const THIS_TAB = 'This tab'

/** What the tunnel popover asks of the tabs, injected so the controller never imports them. */
export interface TabTunnels {
  /** The tab `id`'s choice (absent when it has none) and the address of the page it shows, or the one it is opening when it has no page yet; undefined when no such tab is open. */
  readonly choiceOf: (id: string) => { readonly choice: TabTunnelChoice | undefined, readonly address?: string } | undefined
  /** Gives the tab the choice (null takes it away); the tab may keep what it had when the move cannot be made, so the choice is read back. */
  readonly set: (id: string, choice: TabTunnelChoice | null) => void
}

export const NO_TABS: TabTunnels = { choiceOf: () => undefined, set: () => {} }

export interface TabTunnelFacts {
  readonly choice: TabTunnelChoice | undefined
  /** The whole browser is on the default tunnel unless an origin says otherwise. */
  readonly everywhere: boolean
  readonly defaultKind: SiteTunnelKind
  readonly unreadable: boolean
  /** The tunnel every website takes while the settings cannot be read (`unreadableTunnel`); undefined while they can be. */
  readonly unreadableKind?: SiteTunnelKind
  readonly blocked: SiteTunnel['blocked']
  readonly proxy: SiteTunnel['proxy']
}

/**
 * The tunnel a tab's websites go through now: its choice when it is a tunnel, else the tunnel every website takes while the settings
 * cannot be read (which a direct choice yields to), else none for a direct choice, else the default tunnel while the whole browser
 * is on one, else none (`tabWebsitesTunnel`).
 */
export function tabVia (choice: TabTunnelChoice | undefined, everywhere: boolean, defaultKind: SiteTunnelKind, unreadableKind?: SiteTunnelKind): SiteTunnelKind | null {
  return tabWebsitesTunnel(choice, everywhere ? defaultKind : undefined, unreadableKind) ?? null
}

/** The tunnel switches of a tab. A tab's choice moves no website's own storage for the first time the way a website's entry does, so it asks no notice first. */
export function tabTunnel (facts: TabTunnelFacts): SiteTunnel {
  return {
    via: tabVia(facts.choice, facts.everywhere, facts.defaultKind, facts.unreadableKind),
    following: facts.choice === undefined,
    subject: 'tab',
    blocked: facts.blocked,
    notices: {},
    swarm: false,
    unreadable: facts.unreadable,
    defaultKind: facts.defaultKind,
    proxy: facts.proxy,
    ...(facts.choice === undefined ? {} : { tabChoice: facts.choice })
  }
}

export interface TabSiteFacts {
  readonly origin: string
  readonly choice: TabTunnelChoice | undefined
  /** The website's own entry, undefined for none. */
  readonly entry: TunnelEntry | undefined
  /** The profile the website's own entry puts it in (the one every website takes while the settings cannot be read). */
  readonly ownProfile: Profile | undefined
  readonly everywhere: boolean
  /** The tunnel every website takes while the settings cannot be read; undefined while they can be. */
  readonly unreadableKind?: SiteTunnelKind
  /** The website's own panel, built for the tunnel the page really goes through: why a tunnel cannot be chosen, the storage notices, Swarm, the proxy, whether the settings could be read. */
  readonly site: SiteTunnel
}

/**
 * The tunnel switches of a tab showing a website: what the page really does (the tab's choice over the website's own entry, else the
 * entry, else the browser), with everything the website's own panel tells, and the "Always" switch that saves the tab's choice as the
 * website's entry. The rows move the tab (`planMove`), and the switch decides whether the choice outlives the tab.
 */
export function tabSiteTunnel (facts: TabSiteFacts): SiteTunnel {
  const { site, choice, entry, origin } = facts
  const browser = tabVia(undefined, facts.everywhere, site.defaultKind, facts.unreadableKind) ?? undefined
  const profile = profileForTab(choice, origin, facts.ownProfile)
  return {
    blocked: site.blocked,
    notices: site.notices,
    swarm: site.swarm,
    unreadable: site.unreadable,
    defaultKind: site.defaultKind,
    proxy: site.proxy,
    via: tunnelOfPage(choice, origin, facts.ownProfile, browser) ?? null,
    following: choice === undefined && entry === undefined,
    subject: 'tab',
    ...(profile === undefined ? {} : { profile }),
    ...(choice === undefined ? {} : { tabChoice: choice }),
    always: { ...alwaysState({ choice, entry, everywhere: facts.everywhere }), ...(entry === undefined ? {} : { entry: entry === 'off' ? null : entry }) }
  }
}
