// The page a page tool works on: the active tab's contents and its title, or nothing when there is none to act on.
import type { WebContents } from 'electron'
import type { ShellWindow } from '../shell/window-registry.js'

export interface ActivePage {
  readonly wc: WebContents
  readonly id: string
  readonly title: string
  readonly url: string
}

export function activePage (window: ShellWindow): ActivePage | undefined {
  const wc = window.tabs.activeWebContents()
  if (wc === undefined || wc.isDestroyed()) return undefined
  const { tabs, activeTabId } = window.tabs.getState()
  const tab = tabs.find((entry) => entry.id === activeTabId)
  if (tab === undefined) return undefined
  return { wc, id: tab.id, title: tab.title, url: wc.getURL() }
}
