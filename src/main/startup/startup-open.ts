// Puts the plan's tabs into a window and brings saved windows back, each through the display-aware placement.
import { openSnapshot } from '../session-restore/open-snapshot.js'
import { optionsFor } from '../session-restore/restore.js'
import type { Displays } from '../session-restore/restore.js'
import type { ClosedStack } from '../session-restore/closed-stack.js'
import type { SavedWindow } from '../session-restore/session-types.js'
import type { TabManager } from '../shell/tabs.js'
import { restoreGroups } from '../tab-groups/restore-groups.js'
import type { ShellWindowOptions } from '../shell/window-options.js'
import type { StartupPlan } from './startup-plan.js'

/** The first window's tabs: the planned ones behind, the one that was in front in front, then the command-line addresses with the first of them in front. */
export function fillFirst (first: StartupPlan['first']): (tabs: TabManager) => void {
  return (tabs) => {
    const opened: string[] = []
    for (const tab of first.tabs) {
      if (!tabs.hasRoom()) break
      opened.push(openSnapshot(tabs, tab, false) ?? '')
    }
    first.urls.forEach((url, index) => { tabs.createTab(url, index === 0) })
    const wanted = opened[first.saved?.active ?? 0]
    const front = wanted !== undefined && wanted !== '' ? wanted : opened.find((id) => id !== '')
    if (first.urls.length === 0) {
      if (front === undefined) tabs.createTab()
      else tabs.activateTab(front)
    }
    if (first.saved !== undefined) restoreGroups(tabs, first.saved, opened, first.urls.length > 0 ? undefined : front)
  }
}

/** Opens each saved window. `inactive` shows them without taking focus; `allShown` runs once every one has been shown. */
export function restoreWindows (windows: readonly SavedWindow[], openWindow: (options: ShellWindowOptions) => void, displays: Displays, behind?: { readonly allShown: () => void }): void {
  let waiting = windows.length
  for (const window of windows) {
    openWindow({
      ...optionsFor(window, displays),
      ...(behind === undefined ? {} : { inactive: true, shown: () => { waiting -= 1; if (waiting === 0) behind.allShown() } })
    })
  }
}

/**
 * The closed stack holds the previous session's windows as closed windows; once they are open again, Reopen must
 * not offer them. Returns the windows that were still on it: one that Reopen already brought back is not on it.
 */
export function takeOffStack (stack: ClosedStack, windows: readonly SavedWindow[]): SavedWindow[] {
  const taken: SavedWindow[] = []
  for (const entry of stack.list()) {
    if (entry.kind === 'window' && windows.includes(entry.window) && stack.take(entry.id) !== undefined) taken.push(entry.window)
  }
  return windows.filter((window) => taken.includes(window))
}
