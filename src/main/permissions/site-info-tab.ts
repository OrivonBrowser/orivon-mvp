// The tunnel popover when it is about a tab, not a website: every website the tab opens goes through the tunnel the tab
// carries (`../route/tab-tunnel.ts`, ADR-0101). Pure: the controller reads the routes and the tabs, this builds what the
// popover shows from what it read.

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
  readonly blocked: SiteTunnel['blocked']
  readonly proxy: SiteTunnel['proxy']
}

/** The tunnel a tab's websites go through now: its choice, else the default tunnel while the whole browser is on one, else none. */
export function tabVia (choice: TabTunnelChoice | undefined, everywhere: boolean, defaultKind: SiteTunnelKind): SiteTunnelKind | null {
  if (choice === 'direct') return null
  if (choice !== undefined) return choice
  return everywhere ? defaultKind : null
}

/** The tunnel switches of a tab. A tab's choice moves no website's own storage for the first time the way a website's entry does, so it asks no notice first. */
export function tabTunnel (facts: TabTunnelFacts): SiteTunnel {
  return {
    via: tabVia(facts.choice, facts.everywhere, facts.defaultKind),
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
