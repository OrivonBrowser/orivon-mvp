// What the next start and a reopened window do with saved windows: the calls the start-up choice makes.
import type { ShellWindowOptions } from '../shell/window-options.js'
import type { TabManager } from '../shell/tabs.js'
import type { ClosedStack } from './closed-stack.js'
import { openSnapshot } from './open-snapshot.js'
import type { SavedSession, SavedWindow } from './session-types.js'

/**
 * A window's `first`: opens its tabs in order and puts the one that was in front, in front. A window with
 * nothing to open (or nothing that may open) shows the new-tab page.
 */
export function fillTabs (saved: SavedWindow): (tabs: TabManager) => void {
  return (tabs) => {
    const opened: string[] = []
    for (const tab of saved.tabs) {
      if (!tabs.hasRoom()) break
      // Behind, so each address loads without taking the window.
      const id = openSnapshot(tabs, tab, false)
      opened.push(id ?? '')
    }
    const wanted = opened[saved.active]
    const front = wanted !== undefined && wanted !== '' ? wanted : opened.find((id) => id !== '')
    if (front === undefined) tabs.createTab()
    else tabs.activateTab(front)
  }
}

/** Opens each saved window where it was. `openWindow` is the shell's (`CommandDeps.openWindow`). */
export function restoreWindows (saved: SavedSession, openWindow: (options: ShellWindowOptions) => void): void {
  for (const window of saved.windows) {
    openWindow({ place: window.bounds, maximized: window.maximized, first: fillTabs(window) })
  }
}

/** The windows the previous session had become the first entries of the closed stack, the last one on top. */
export function seedClosedStack (stack: ClosedStack, previous: SavedSession | null): void {
  for (const window of previous?.windows ?? []) {
    if (window.tabs.length > 0) stack.push({ kind: 'window', window })
  }
}
