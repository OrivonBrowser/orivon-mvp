// What the routes and a report read of the tabs that carry a tunnel choice (ADR-0101), apart from setting one
// (`tab-tunnel-choice.ts`, which swaps a view). Electron-free: plain values and the registry's types.
import { isPersistableOrigin, originFromUrl } from '../../broker/policy/origin.js'
import { keepSiteApart, siteProfileOf } from '../route/site-routes.js'
import { tunnelOfChoice } from '../route/tab-tunnel.js'
import type { TabTunnelChoice } from '../route/tab-tunnel.js'
import type { BrowserTunnelTab } from '../permissions/site-info.js'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import type { TunnelKind } from '../route/route-state.js'
import type { TabRecord } from './tab-types.js'
import type { WindowRegistry } from './window-registry.js'

/**
 * A tab with a choice committed `url` in a profile session: the website has storage there that no entry of its own records, so
 * it is recorded the way a switch does, and Settings lists it and Clear browsing data reaches the profile. Nothing for a tab with
 * no choice, whose websites are recorded by the switch that put them there, and nothing for an origin in the profile's memory
 * twin, which has no storage on disk to remove. A record that cannot be saved is logged, without the address, and never undoes
 * the navigation that committed.
 */
export function noteTabVisit (record: TabRecord, url: string): void {
  if (record.tunnelChoice === undefined) return
  const profile = siteProfileOf(record.partition)
  const origin = originFromUrl(url)
  if (profile === undefined || origin === null || !isPersistableOrigin(origin)) return
  try {
    keepSiteApart(origin, profile)
  } catch (error) {
    console.error('[route] could not record that a website has storage in a profile:', error)
  }
}

/** What the routes need to know of one tab. */
export interface ShownTab {
  readonly choice: TabTunnelChoice | undefined
  readonly url: string
  readonly inflightUrl: string | undefined
}

/**
 * The tunnel a tab with a tunnel choice sends the website at `origin` through, when one shows it or is loading it. An installed
 * app (`isInstalledApp`) is none: it keeps its own session and route whatever the tab says.
 */
export function kindShowing (tabs: Iterable<ShownTab>, origin: string, isInstalledApp: (origin: string) => boolean = () => false): TunnelKind | undefined {
  if (isInstalledApp(origin)) return undefined
  for (const tab of tabs) {
    const kind = tunnelOfChoice(tab.choice)
    if (kind === undefined) continue
    if (originFromUrl(tab.url) === origin || (tab.inflightUrl !== undefined && originFromUrl(tab.inflightUrl) === origin)) return kind
  }
  return undefined
}

/** The tabs that carry a choice, in every window. */
export function * tabsWithChoice (windows: Pick<WindowRegistry, 'all'>): Generator<ShownTab> {
  for (const window of windows.all()) {
    if (window.window.isDestroyed()) continue
    for (const id of window.tabs.ids()) {
      const record = window.tabs.record(id)
      if (record?.tunnelChoice !== undefined) yield { choice: record.tunnelChoice, url: window.tabs.liveWebContents(id)?.getURL() ?? '', inflightUrl: record.inflightUrl }
    }
  }
}

/** How many tabs carry each choice: counts only, for a report, never an address or an origin. */
export function tabChoiceCounts (windows: Pick<WindowRegistry, 'all'>): Record<TabTunnelChoice, number> {
  const counts: Record<TabTunnelChoice, number> = { nym: 0, socks5: 0, direct: 0 }
  for (const tab of tabsWithChoice(windows)) if (tab.choice !== undefined) counts[tab.choice] += 1
  return counts
}

/** A title a website made is cut here: the prompt that lists the tabs shows it on one line, and the popup is not the place for an essay. */
const TITLE_LIMIT = 300

/**
 * The tabs that carry a choice, in every window, named as the tunnel popup lists them: the page's own title, else the address it
 * shows, and what a sleeping tab kept of both. An empty name is a tab with neither (a new tab before it has loaded).
 */
export function browserTunnelTabs (windows: Pick<WindowRegistry, 'all'>): BrowserTunnelTab[] {
  const tabs: BrowserTunnelTab[] = []
  for (const window of windows.all()) {
    if (window.window.isDestroyed()) continue
    for (const id of window.tabs.ids()) {
      const record = window.tabs.record(id)
      if (record?.tunnelChoice === undefined) continue
      const contents = window.tabs.liveWebContents(id)
      const title = (contents?.getTitle() ?? record.sleeping?.title ?? '').trim()
      const url = contents?.getURL() ?? record.sleeping?.url ?? ''
      tabs.push({ title: (title === '' ? BUILTIN_ADDRESSES.displayUrl(url) : title).slice(0, TITLE_LIMIT), choice: record.tunnelChoice })
    }
  }
  return tabs
}
