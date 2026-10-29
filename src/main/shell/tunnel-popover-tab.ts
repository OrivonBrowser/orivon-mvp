// Which tab the tunnel button's popover is about, when it is about a tab and not a website (ADR-0101). Pure.
import { isolationKeyFromUrl, originFromUrl } from '../../broker/policy/origin.js'
import { isProfilePartition } from '../route/site-partition.js'
import type { TabsSnapshot } from './tab-types.js'

/** The address a tab with no page yet is opening, by tab id: its `url` is '' until the first page commits, and main holds the address in flight (`TabRecord.inflightUrl`). */
export type OpeningAddress = (id: string) => string | undefined

/**
 * The address the tab in front is opening and has not committed, or undefined when it shows a page (which answers for itself), opens
 * nothing, or no tab is in front. The tunnel button of a tab with no page sends the chrome no address, so main reads it off the tab.
 */
export function addressBeingOpened (state: TabsSnapshot, opening: OpeningAddress): string | undefined {
  const active = state.tabs.find((tab) => tab.id === state.activeTabId)
  return active?.url === '' ? opening(active.id) : undefined
}

/**
 * The id of the tab in front when the tunnel button's popover is about the tab: a new tab, which shows no website to be about; a tab
 * that carries a tunnel choice, whose every website the choice decides; and a tab with no page that opens no address with an origin,
 * which has no website to be about either. Not an installed app, nor a page in a session an app or a temporary route made for it (a
 * popup an app opened, a website opened through an app's tunnel): those keep the tunnel of that session whatever the tab carries, so
 * the popover is about the page. Not any page of a tab with no choice, nor a tab with no page that is opening a website (the popover
 * is about that website, as it is once the page has come), nor a blank page that is no new tab, nor a page of the shell's own, which
 * has no button. Everything is read from the tab's record (`state`, `partitionOf`, `opening`), never from what the chrome says it shows.
 */
export function tabForTunnelPopover (state: TabsSnapshot, partitionOf: (id: string) => string | undefined, isApp: (origin: string) => boolean, opening: OpeningAddress = () => undefined): string | undefined {
  const active = state.tabs.find((tab) => tab.id === state.activeTabId)
  if (active === undefined || active.isInternal) return undefined
  if (active.isNewTab) return active.blankPage === true ? undefined : active.id
  const address = active.url === '' ? opening(active.id) : active.url
  const showsNoWebsite = active.url === '' && (address === undefined || isolationKeyFromUrl(address) === null)
  if (active.tunnelChoice === undefined && !showsNoWebsite) return undefined
  const origin = address === undefined ? null : originFromUrl(address)
  if (origin !== null && isApp(origin)) return undefined
  const partition = partitionOf(active.id)
  return partition === undefined || isProfilePartition(partition) ? active.id : undefined
}
