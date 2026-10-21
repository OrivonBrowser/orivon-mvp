// Brings an app's page in front for a link sent to it: the tab already showing the app, in whichever window holds it,
// else a new tab at the app's address in the window the link came from. Pure over the window registry's reading
// methods, so it is unit tested with fakes.
import type { ShellWindow } from '../shell/window-registry.js'

export interface AppWindows {
  liveTabsOn: (origin: string) => object[]
  findTab: (contents: never) => { window: ShellWindow, tabId: string } | null
  focused: () => ShellWindow | undefined
}

/** Raises a window the way a link handed over by another program does (`shell/opener.ts`). */
function bringForward (entry: ShellWindow): void {
  if (entry.window.isMinimized()) entry.window.restore()
  entry.window.show()
  entry.window.focus()
}

export function showApp (windows: AppWindows, origin: string, from: object | undefined): void {
  const showing = windows.liveTabsOn(origin)[0]
  const holder = showing === undefined ? null : windows.findTab(showing as never)
  if (holder !== null) {
    holder.window.tabs.activateTab(holder.tabId)
    bringForward(holder.window)
    return
  }
  const target = (from === undefined ? undefined : windows.findTab(from as never)?.window) ?? windows.focused()
  if (target === undefined) return
  target.tabs.createTab(`${origin}/`, true)
  bringForward(target)
}
