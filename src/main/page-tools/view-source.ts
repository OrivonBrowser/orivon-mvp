// View page source: the page's own source in a new tab beside it. Only an address the address bar
// would itself accept is passed on, so a page can never reach a `view-source:` tab of a scheme the
// shell does not open.
import { sanitizeDirectUrl } from '../browsing/omnibox.js'
import type { TabManager } from '../shell/tabs.js'

/** The tab manager's side of it, so a test needs no window. */
export type SourceTabs = Pick<TabManager, 'openTrusted' | 'moveTab' | 'getState' | 'record'>

/**
 * Opens the source of `url` in a foreground tab right after the active one. Returns whether a tab
 * opened. An app's own tab is left out: its page may come from the cache Orivon serves, and the
 * source view would fetch the address again from the network instead.
 */
export function openViewSource (tabs: SourceTabs, url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false
  const address = sanitizeDirectUrl(url)
  if (address === null) return false
  const { tabs: order, activeTabId } = tabs.getState()
  if (activeTabId === null) return false
  const fromIndex = order.findIndex((tab) => tab.id === activeTabId)
  const record = tabs.record(activeTabId)
  if (record === undefined || record.partition !== undefined || record.internalPage !== null || record.isDashboardTab) return false
  const opened = tabs.openTrusted(`view-source:${address}`)
  if (opened === undefined) return false
  tabs.moveTab(opened[0], fromIndex + 1)
  return true
}
