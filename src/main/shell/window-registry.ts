// The shell windows this process has open. A window's tabs are found through
// it from outside the window: the new-tab page's IPC arrives on a
// process-wide channel and has to reach the manager of whichever window holds
// the sending tab.
import type { BaseWindow, WebContents, WebContentsView } from 'electron'
import type { OverlayHost } from '../overlays/overlay-types.js'
import type { TabManager } from './tabs.js'

export interface ShellWindow {
  readonly window: BaseWindow
  readonly chrome: WebContentsView
  readonly tabs: TabManager
  /** Orivon HTML shown above the page: the main menu and every feature's overlay. */
  readonly overlays: OverlayHost
  /** A page in this window holds the screen (HTML fullscreen), so the browser's keys wait. */
  readonly shortcutsSuspended: () => boolean
  /** Lays the chrome, the tabs and the overlays out again: what a feature that changes the page area calls. */
  readonly relayout: () => void
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

  /** The window a webContents is in: its chrome, one of its tabs, or any other view in it (a popover). */
  findOwner (contents: WebContents): ShellWindow | undefined {
    for (const entry of this.windows) {
      if (entry.window.isDestroyed()) continue
      if (entry.chrome.webContents === contents || entry.tabs.findTabIdByWebContents(contents) !== null) return entry
      if (entry.window.contentView.children.some((view) => (view as Partial<WebContentsView>).webContents === contents)) return entry
    }
    return undefined
  }

  /** The window the person is using: the focused one, else the newest. */
  focused (): ShellWindow | undefined {
    const live = [...this.windows].filter((entry) => !entry.window.isDestroyed())
    return live.find((entry) => entry.window.isFocused()) ?? live.at(-1)
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
