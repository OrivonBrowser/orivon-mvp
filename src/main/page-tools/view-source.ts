// View page source: the page's own source in a new tab beside it. Only an address the address bar
// would itself accept is passed on, so a page can never reach a `view-source:` tab of a scheme the
// shell does not open.
import { sanitizeDirectUrl } from '../browsing/omnibox.js'
import { partitionForTab } from '../shell/tab-partition.js'
import type { TabManager } from '../shell/tabs.js'

/** The tab manager's side of it, so a test needs no window. */
export type SourceTabs = Pick<TabManager, 'openTrusted' | 'moveTab' | 'getState' | 'record'>

/**
 * The tab for the source of `address`. When the tab `fromTab` has a tunnel choice, the source opens in the session that choice
 * calls for and keeps the choice, so the fetch of the page leaves by the tunnel of the tab it was asked from and never from the
 * shared session.
 */
function openSourceTab (tabs: SourceTabs, address: string, fromTab: string | null): ReturnType<SourceTabs['openTrusted']> {
  const target = `view-source:${address}`
  const choice = fromTab === null ? undefined : tabs.record(fromTab)?.tunnelChoice
  return choice === undefined ? tabs.openTrusted(target) : tabs.openTrusted(target, partitionForTab(address, choice), choice)
}

/** Whether a tab showing `url` may have its source shown: a web address, in a tab that is neither an app's nor one of the shell's own. */
export function canViewSource (record: { readonly partition?: string | undefined, readonly internalPage: unknown, readonly isDashboardTab: boolean } | undefined, url: string): boolean {
  if (record === undefined || record.partition !== undefined || record.internalPage !== null || record.isDashboardTab) return false
  return /^https?:\/\//i.test(url) && sanitizeDirectUrl(url) !== null
}

/**
 * Opens the source of `url` in a foreground tab right after the active one. Returns whether a tab
 * opened. An app's own tab is left out: its page may come from the cache Orivon serves, and the
 * source view would fetch the address again from the network instead.
 */
export function openViewSource (tabs: SourceTabs, url: string): boolean {
  const address = sanitizeDirectUrl(url)
  const { tabs: order, activeTabId } = tabs.getState()
  if (activeTabId === null || address === null) return false
  const fromIndex = order.findIndex((tab) => tab.id === activeTabId)
  if (!canViewSource(tabs.record(activeTabId), url)) return false
  const opened = openSourceTab(tabs, address, activeTabId)
  if (opened === undefined) return false
  tabs.moveTab(opened[0], fromIndex + 1)
  return true
}

/**
 * Opens the source of an address the person typed, in a foreground tab right after the active one, whatever the active
 * tab shows: it may be the new-tab page, one of the shell's own pages or an app, none of which is the page being asked
 * about. Only a web address the address bar would accept opens. Returns whether a tab opened.
 */
export function openTypedViewSource (tabs: SourceTabs, url: string): boolean {
  const address = sanitizeDirectUrl(url)
  if (address === null || !/^https?:\/\//i.test(address)) return false
  const { tabs: order, activeTabId } = tabs.getState()
  const fromIndex = order.findIndex((tab) => tab.id === activeTabId)
  const opened = openSourceTab(tabs, address, activeTabId)
  if (opened === undefined) return false
  if (fromIndex !== -1) tabs.moveTab(opened[0], fromIndex + 1)
  return true
}
