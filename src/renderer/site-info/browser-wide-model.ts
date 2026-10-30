import type { BrowserTunnel, SiteInfo } from '../../main/permissions/site-info.js'
import type { TabTunnelChoice } from '../../main/route/tab-tunnel.js'
import { UNREADABLE_HINT } from './tunnel-view.js'
import { HELD_LINE, inUseLine, tunnelRows } from './tunnels-model.js'
import type { NodesModel, PromptModel, TunnelLine, TunnelListModel, TunnelView } from './tunnels-model.js'

// The tunnels popup has two panels: the first is about what the popup was opened for (this tab, site or app), the second about the
// whole browser. Which one opens, what they are called, and the Browser-wide panel's rows, nodes switch and question are composed
// here, as data, so they are tested without a DOM. The rows are `tunnels-model.ts`'s: the same ones, fed the browser's facts.

export type Panel = 'first' | 'browser'

export const BROWSER_LABEL = 'Browser-wide'
export const NODES_LABEL = 'Also use for IPFS and Swarm nodes'
export const NODES_LINE = 'More private, but pages from these networks load more slowly.'
export const BROWSER_PROMPT = 'You are setting this tunnel browser-wide, but some tabs will keep using their tab-specific tunnel.'
export const BROWSER_FAILED = 'The tunnel could not be changed for the browser.'
/** A tab with neither a title nor an address yet. */
const UNNAMED_TAB = 'New tab'

/** What the first panel is called: what its switches act on. A page with no tunnel of its own (this computer) is still asked about from a tab. */
export function firstPanelLabel (info: SiteInfo): string {
  switch (info.tunnel?.subject) {
    case 'site': return 'This site'
    case 'app': return 'This app'
    default: return 'This tab'
  }
}

/**
 * The panel the popup opens on: Browser-wide when the whole browser is on a tunnel and the page has no choice of its own to show
 * instead (it follows the browser), else the first. A window held to a tunnel shows its rows fixed on the first panel. Decided once
 * per open: the person's own click on a panel holds until the popup closes.
 */
export function initialPanel (info: SiteInfo): Panel {
  if (info.browserTunnel === undefined || info.everywhere !== true || info.tunnelHeld !== undefined) return 'first'
  return info.tunnel === undefined || info.tunnel.following ? 'browser' : 'first'
}

/** What a tab keeps, in the words of the rows: the tunnel it is set to, or none. */
export function keptWords (choice: TabTunnelChoice): string {
  return choice === 'nym' ? 'Nym' : choice === 'socks5' ? 'Your proxy' : 'Direct'
}

function promptFor (browser: BrowserTunnel): PromptModel | null {
  if (browser.tabs.length === 0) return null
  return { text: BROWSER_PROMPT, tabs: browser.tabs.map((tab) => ({ title: tab.title === '' ? UNNAMED_TAB : tab.title, kept: keptWords(tab.choice) })) }
}

function nodesFor (browser: BrowserTunnel, held: boolean): NodesModel {
  // With no tunnel on browser-wide this cannot be turned on, as the nodes connect directly then; once saved on it can still be turned off,
  // because the nodes then refuse the websites that have a tunnel of their own.
  const idle = browser.via === null && !browser.nodes
  return { label: NODES_LABEL, line: NODES_LINE, on: browser.nodes, disabled: held || browser.unreadable || idle }
}

/**
 * The Browser-wide panel. `view.pending` is the tunnel the person moved a switch to while the question is open (null: none),
 * undefined while it is not; the question is open exactly while a tunnel is pending.
 */
export function browserListModel (info: SiteInfo, view: TunnelView): TunnelListModel {
  const browser = info.browserTunnel
  const hint = { text: '' }
  if (browser === undefined) return { rows: [], notes: [], empty: null, hint, nodes: null, prompt: null }
  const held = info.tunnelHeld !== undefined
  const fixed = held || browser.unreadable
  const rows = tunnelRows({ via: browser.via, blocked: browser.blocked, proxy: browser.proxy, held, fixed, inUse: inUseLine(browser.route, browser.nym, 'browser') }, view)
  const notes: TunnelLine[] = [
    ...(held ? [{ text: HELD_LINE, down: false }] : []),
    ...(browser.unreadable ? [{ text: UNREADABLE_HINT, down: true }] : [])
  ]
  const asking = view.pending !== undefined && view.pending !== null
  return { rows, notes, empty: null, hint, nodes: nodesFor(browser, held), prompt: asking ? promptFor(browser) : null }
}
