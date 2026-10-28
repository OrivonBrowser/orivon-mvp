// Which tab the tunnel button's popover is about, when it is about a tab and not a website (ADR-0101). Pure.
import { originFromUrl } from '../../broker/policy/origin.js'
import { isProfilePartition } from '../route/site-partition.js'
import type { TabsSnapshot } from './tab-types.js'

/**
 * The id of the tab in front when the tunnel button's popover is about the tab: a new tab, which shows no website to be about,
 * and a tab that carries a tunnel choice, whose every website the choice decides. Not an installed app, nor a page in a session an
 * app or a temporary route made for it (a popup an app opened, a website opened through an app's tunnel): those keep the tunnel of
 * that session whatever the tab carries, so the popover is about the page. Not any page of a tab with no choice, nor a blank page
 * that is no new tab, nor a page of the shell's own, which has no button. Everything is read from the tab's record (`state`,
 * `partitionOf`), never from what the chrome says it shows.
 */
export function tabForTunnelPopover (state: TabsSnapshot, partitionOf: (id: string) => string | undefined, isApp: (origin: string) => boolean): string | undefined {
  const active = state.tabs.find((tab) => tab.id === state.activeTabId)
  if (active === undefined || active.isInternal) return undefined
  if (active.isNewTab) return active.blankPage === true ? undefined : active.id
  if (active.tunnelChoice === undefined) return undefined
  const origin = originFromUrl(active.url)
  if (origin !== null && isApp(origin)) return undefined
  const partition = partitionOf(active.id)
  return partition === undefined || isProfilePartition(partition) ? active.id : undefined
}
