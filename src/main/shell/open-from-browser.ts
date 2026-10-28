// Where an address that a person or a store of the browser's own names becomes a tab. A web address is an
// ordinary tab; a local file goes through `openLocalFile`, which puts it in its own session (../local-files/).
// A page's link, `window.open` and an extension never come here: they cannot open a file.
import { localFileKey } from '../../broker/policy/origin.js'
import { parseLocalFileInput } from '../browsing/local-file-input.js'
import type { TabManager } from './tabs.js'
import type { TabTunnelChoice } from '../route/tab-tunnel.js'

/** What the opening of an address needs of a window's tabs. */
export type BrowserTabs = Pick<TabManager, 'createTab' | 'openLocalFile' | 'openLocalFileNow' | 'navigate' | 'closeTab' | 'getState' | 'activeWebContents'>

/** Opens `url` in a new tab, in front unless `active` is false. */
export function openFromBrowser (tabs: Pick<BrowserTabs, 'createTab' | 'openLocalFile'>, url: string, active = true): void {
  if (localFileKey(url) !== null) void tabs.openLocalFile(url, active).catch((error: unknown) => { console.error('[shell] open local file failed:', error) })
  else tabs.createTab(url, active)
}

/**
 * An address that a surface of the tab in front asks for (the pop-ups bubble, the site-info panel) opens in a tab that keeps the
 * tunnel choice of the tab in front, so the new tab's first request leaves by the tunnel of the page it was asked from.
 */
export function openFromActiveTab (tabs: Pick<TabManager, 'createTab' | 'activeTunnelChoice'>, url: string): string {
  return tabs.createTab(url, true, undefined, tabs.activeTunnelChoice())
}

/**
 * `openFromBrowser` for a caller that wants the tab's id (a restored tab gets its history and place, and keeps its tunnel
 * choice). A local file whose fuse answer is not in yet opens when the answer arrives and has no id here.
 */
export function openNowFromBrowser (tabs: Pick<BrowserTabs, 'createTab' | 'openLocalFile' | 'openLocalFileNow'>, url: string, active = true, tunnelChoice?: TabTunnelChoice): string | undefined {
  if (localFileKey(url) === null) return tabs.createTab(url, active, undefined, tunnelChoice)
  const id = tabs.openLocalFileNow(url, active)
  if (id === undefined) void tabs.openLocalFile(url, active).catch((error: unknown) => { console.error('[shell] open local file failed:', error) })
  return id
}

/**
 * The address bar's Enter, a bookmark opened here and a choice of the dropdown: text that names a local file opens
 * that file in a new tab (the empty new-tab page it was typed on goes), anything else is the tab's own navigation.
 */
export async function navigateFromBrowser (tabs: BrowserTabs, tabId: string, input: string): Promise<void> {
  const file = parseLocalFileInput(input)
  if (file === null) {
    tabs.navigate(tabId, input)
    return
  }
  const wasBlank = tabs.getState().tabs.find((tab) => tab.id === tabId)?.isNewTab === true
  const opened = await tabs.openLocalFile(file, true)
  if (opened === undefined) return
  if (wasBlank) tabs.closeTab(tabId)
  tabs.activeWebContents()?.focus()
}
