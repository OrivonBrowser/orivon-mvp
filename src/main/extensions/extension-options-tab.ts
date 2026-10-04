// An extension's options page is one tab: opening it again brings the tab that already shows it to the front.
import type { BaseWindow, WebContents } from 'electron'
import { isExtensionOpened } from './extension-opened-pages.js'

const EXTENSION_URL = /^chrome-extension:\/\/([a-p]{32})\//

/** The part of a shell window this needs. */
export interface WindowWithTabs {
  readonly window: Pick<BaseWindow, 'focus' | 'isDestroyed'>
  readonly tabs: {
    readonly ids: () => readonly string[]
    readonly liveWebContents: (id: string) => WebContents | undefined
    readonly activateTab: (id: string) => void
  }
}

/** Activates the tab showing `url` that the host opened for its extension, in whichever window holds it; false when there is none. */
export function activateTabShowing (windows: readonly WindowWithTabs[], url: string): boolean {
  const extensionId = EXTENSION_URL.exec(url)?.[1]
  if (extensionId === undefined) return false
  for (const entry of windows) {
    if (entry.window.isDestroyed()) continue
    for (const id of entry.tabs.ids()) {
      const contents = entry.tabs.liveWebContents(id)
      if (contents === undefined || contents.getURL() !== url || !isExtensionOpened(contents, extensionId)) continue
      entry.tabs.activateTab(id)
      entry.window.focus()
      return true
    }
  }
  return false
}
