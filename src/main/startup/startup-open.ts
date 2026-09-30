// Puts the plan's tabs into a window and brings saved windows back, each through the display-aware placement.
import { openSnapshot } from '../session-restore/open-snapshot.js'
import { fillTabs } from '../session-restore/restore.js'
import type { ClosedStack } from '../session-restore/closed-stack.js'
import type { SavedWindow } from '../session-restore/session-types.js'
import type { TabManager } from '../shell/tabs.js'
import type { ShellWindowOptions } from '../shell/window-options.js'
import { placementFor } from '../window-state/placement.js'
import type { Rect } from '../window-state/placement.js'
import type { StartupPlan } from './startup-plan.js'

export type Displays = readonly { readonly bounds: Rect }[]

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
    if (first.urls.length > 0) return
    if (front === undefined) tabs.createTab()
    else tabs.activateTab(front)
  }
}

/** A saved window's options: its place only when a screen still shows it. */
export function optionsFor (saved: SavedWindow, displays: Displays): ShellWindowOptions {
  const { place, maximized } = placementFor({ bounds: saved.bounds, maximized: saved.maximized }, displays)
  return { ...(place === undefined ? {} : { place }), maximized, first: fillTabs(saved) }
}

export function restoreWindows (windows: readonly SavedWindow[], openWindow: (options: ShellWindowOptions) => void, displays: Displays): void {
  for (const window of windows) openWindow(optionsFor(window, displays))
}

/** The closed stack holds the previous session's windows as closed windows; once they are open again, Reopen must not offer them. */
export function takeOffStack (stack: ClosedStack, windows: readonly SavedWindow[]): void {
  for (const entry of stack.list()) {
    if (entry.kind === 'window' && windows.includes(entry.window)) stack.take(entry.id)
  }
}
