// The shell windows this process has open. A window's tabs are found through
// it from outside the window: the new-tab page's IPC arrives on a
// process-wide channel and has to reach the manager of whichever window holds
// the sending tab.
import type { BaseWindow, WebContents, WebContentsView } from 'electron'
import type { TabManager } from './tabs.js'

export interface ShellWindow {
  readonly window: BaseWindow
  readonly chrome: WebContentsView
  readonly tabs: TabManager
}

export class WindowRegistry {
  private readonly windows = new Set<ShellWindow>()

  /** Returns the removal, for the window's `closed` event. */
  add (entry: ShellWindow): () => void {
    this.windows.add(entry)
    return () => { this.windows.delete(entry) }
  }

  all (): readonly ShellWindow[] {
    return [...this.windows]
  }

  /** The window and tab a tab's webContents belongs to, in any window. */
  findTab (contents: WebContents): { window: ShellWindow, tabId: string } | null {
    for (const window of this.windows) {
      const tabId = window.tabs.findTabIdByWebContents(contents)
      if (tabId !== null) return { window, tabId }
    }
    return null
  }
}
