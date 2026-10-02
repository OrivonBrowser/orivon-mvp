// The colour behind a window's views. The views are laid out a tick after the window moves, so a resize or a
// maximise shows this colour in the strip they have not reached yet: it is the shown tab's own resting colour,
// or the strip flashes against the page. The title-bar overlay keeps the chrome's colour, which the chrome
// view covers anyway. Tied to Electron: a window's colour.
import type { BaseWindow } from 'electron'
import { restingColor } from './sheet-backdrop.js'
import type { TabManager } from './tabs.js'
import { onThemeUpdated } from './theme-colors.js'

/** Keeps `win`'s background in step with the active tab, through every tab switch, navigation, split and theme
 * change. Returns the removal. */
export function followActiveTabBacking (win: BaseWindow, tabs: TabManager): () => void {
  let applied = ''
  const sync = (id: string | null): void => {
    if (win.isDestroyed()) return
    const record = id === null ? undefined : tabs.record(id)
    // A tab whose page is being torn down (closed by an extension, a crash) has no webContents to read: the
    // colour it had stays until the tab goes or another is shown.
    if (id === null || record === undefined || tabs.liveWebContents(id) === undefined) return
    const color = restingColor(record)
    if (color === applied) return
    applied = color
    win.setBackgroundColor(color)
  }
  const stopTabs = tabs.onStateChange((state) => { sync(state.activeTabId) })
  const stopTheme = onThemeUpdated(() => { applied = ''; sync(tabs.getState().activeTabId) })
  sync(tabs.getState().activeTabId)
  return () => { stopTabs(); stopTheme() }
}
