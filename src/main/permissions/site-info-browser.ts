// The tunnel popover's Browser-wide panel: the tunnel the whole browser goes through, and the tabs that keep a choice of their
// own whatever is set there (ADR-0101). Pure: the controller reads the routes and the settings, this builds what the panel shows.

import { tabVia } from './site-info-tab.js'
import type { BrowserTunnel, BrowserTunnelTab, SiteRoute, SiteTunnel, SiteTunnelKind } from './site-info.js'
import type { NymState } from '../route/nym-status.js'

/** What the tunnel popover asks of the browser's settings and tabs, injected so the controller never imports the settings store. */
export interface BrowserTunnels {
  /** The tabs in every window that keep a tunnel choice of their own. */
  readonly tabs: () => readonly BrowserTunnelTab[]
  /** Whether the IPFS and Swarm nodes follow the tunnel too. */
  readonly nodes: () => boolean
  /** Saves the tunnel the whole browser takes when it is on one; false when the settings did not take it. */
  readonly setKind: (kind: SiteTunnelKind) => boolean
  /** Turns the whole browser on or off its tunnel; false when the settings did not take it. */
  readonly setEverywhere: (on: boolean) => boolean
  readonly setNodes: (on: boolean) => boolean
}

export const NO_BROWSER: BrowserTunnels = { tabs: () => [], nodes: () => false, setKind: () => false, setEverywhere: () => false, setNodes: () => false }

export interface BrowserTunnelFacts {
  readonly everywhere: boolean
  readonly defaultKind: SiteTunnelKind
  readonly nodes: boolean
  readonly unreadable: boolean
  /** The tunnel every website takes while the settings cannot be read (`unreadableTunnel`); undefined while they can be. */
  readonly unreadableKind?: SiteTunnelKind
  readonly blocked: SiteTunnel['blocked']
  readonly proxy: SiteTunnel['proxy']
  readonly tabs: readonly BrowserTunnelTab[]
  readonly route?: SiteRoute
  readonly nym?: NymState
}

/** The tunnel the browser is on: the one every website takes while the settings cannot be read, else the default one while the whole browser is on a tunnel, else none. */
export function browserTunnel (facts: BrowserTunnelFacts): BrowserTunnel {
  return {
    via: tabVia(undefined, facts.everywhere, facts.defaultKind, facts.unreadableKind),
    defaultKind: facts.defaultKind,
    nodes: facts.nodes,
    blocked: facts.blocked,
    proxy: facts.proxy,
    unreadable: facts.unreadable,
    tabs: facts.tabs,
    ...(facts.route === undefined ? {} : { route: facts.route }),
    ...(facts.nym === undefined ? {} : { nym: facts.nym })
  }
}
