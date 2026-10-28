// A tab's tunnel choice as the shell keeps it (ADR-0101): set on a tab, which then moves into the session the choice calls for,
// remembered for the storage a website gets from it, and read back as the tabs' answers to the routes. Electron-free: the
// view swap and the sessions are the shell's own (`tab-parking.ts`, `../route/site-routes.ts`).
import { originFromUrl } from '../../broker/policy/origin.js'
import { ensureSiteSession, keepSiteApart, siteProfileOf } from '../route/site-routes.js'
import { profilePartition } from '../route/site-partition.js'
import { tunnelOfChoice } from '../route/tab-tunnel.js'
import type { TabTunnelChoice } from '../route/tab-tunnel.js'
import type { TunnelKind } from '../route/route-state.js'
import { repartitionView } from './tab-parking.js'
import { partitionChanged } from './tab-partition.js'
import type { TabRecord } from './tab-types.js'
import type { WindowRegistry } from './window-registry.js'

/**
 * Gives the tab `choice` (null takes it away), makes the profile it calls for ready so that the tunnel starts coming up while
 * the person types, and moves the website the tab shows, if it shows one, into the session the choice calls for. The move
 * reloads the page; a move that cannot be made stops the page's loads, so it is never left in the session it was in.
 */
export function setTabTunnelChoice (id: string, record: TabRecord, choice: TabTunnelChoice | null): void {
  const next = choice ?? undefined
  if (record.tunnelChoice === next) return
  if (next === undefined) delete record.tunnelChoice
  else record.tunnelChoice = next
  console.log(`[route] tab tunnel ${next === undefined ? 'cleared' : `chosen: ${next}`} (${id})`)
  if (next !== undefined) ensureSiteSession(profilePartition(next, true), false)
  moveToChoice(id, record)
  record.host.emitState()
}

function moveToChoice (id: string, record: TabRecord): void {
  // The new-tab page, a page of the shell and a sleeping tab show no website: the first address, or the wake, follows the choice.
  if (record.isDashboardTab || record.internalPage !== null || (record.sleeping ?? null) !== null || record.host.isClosing()) return
  const contents = record.view.webContents
  if (contents.isDestroyed()) return
  const url = contents.getURL()
  const swap = partitionChanged(url, record.partition, record.tunnelChoice)
  if (swap === undefined) return
  try {
    repartitionView(id, record, url, swap.to)
  } catch (error) {
    console.error('[route] tab tunnel: the tab could not move to the session its choice calls for; its loads are stopped:', error)
    if (!record.view.webContents.isDestroyed()) record.view.webContents.stop()
  }
}

/**
 * A tab with a choice committed `url` in a profile session: the website has storage there that no entry of its own records, so
 * it is recorded the way a switch does, and Settings lists it and Clear browsing data reaches the profile. Nothing for a tab with
 * no choice, whose websites are recorded by the switch that put them there.
 */
export function noteTabVisit (record: TabRecord, url: string): void {
  if (record.tunnelChoice === undefined) return
  const profile = siteProfileOf(record.partition)
  const origin = originFromUrl(url)
  if (profile !== undefined && origin !== null) keepSiteApart(origin, profile)
}

/** What the routes need to know of one tab. */
export interface ShownTab {
  readonly choice: TabTunnelChoice | undefined
  readonly url: string
  readonly inflightUrl: string | undefined
}

/** The tunnel a tab with a tunnel choice sends the website at `origin` through, when one shows it or is loading it. */
export function kindShowing (tabs: Iterable<ShownTab>, origin: string): TunnelKind | undefined {
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
