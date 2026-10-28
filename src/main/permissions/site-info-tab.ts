// The tunnel popover when it is about a tab, not a website: every website the tab opens goes through the tunnel the tab
// carries (`../route/tab-tunnel.ts`, ADR-0101). Pure: the controller reads the routes and the tabs, this builds what the
// popover shows from what it read.

import { tabWebsitesTunnel } from '../route/tab-tunnel.js'
import type { TabTunnelChoice } from '../route/tab-tunnel.js'
import type { SiteTunnel, SiteTunnelKind } from './site-info.js'

/** What the popover calls the subject of a tab's tunnel, where it names a site's origin for a website. */
export const THIS_TAB = 'This tab'

/** What the tunnel popover asks of the tabs, injected so the controller never imports them. */
export interface TabTunnels {
  /** The tab `id`'s choice (absent when it has none), or undefined when no such tab is open. */
  readonly choiceOf: (id: string) => { readonly choice: TabTunnelChoice | undefined } | undefined
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
