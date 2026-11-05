import type { ChromeAction } from '../chrome-actions.js'
import type { ShellWindow } from '../window-registry.js'

/** How many times a window is repaired within `REPAIR_SPAN_MS`; a chrome that stays hidden after that is left alone. */
const MAX_REPAIRS = 3
const REPAIR_SPAN_MS = 2_000

const repairs = new WeakMap<ShellWindow, number[]>()
const warnedAt = new WeakMap<ShellWindow, number>()

/** The chrome page reports that it reads hidden. When the window is on screen and the chrome view is meant to be shown,
 * the page is wrong, not the window: the overlays are hidden and shown again in one turn, which makes Chromium work out
 * what covers what a second time (README.md's Design notes). Each repair, and a window left alone because three were not
 * enough, is a line of the log, which a bug report carries. */
export const chromeHidden: ChromeAction = (_payload, { window }) => {
  const { window: win, chrome, overlays } = window
  if (win.isDestroyed() || !win.isVisible() || win.isMinimized() || !chrome.getVisible()) return
  const now = Date.now()
  const recent = (repairs.get(window) ?? []).filter((at) => now - at < REPAIR_SPAN_MS)
  if (recent.length >= MAX_REPAIRS) {
    if (now - (warnedAt.get(window) ?? 0) >= REPAIR_SPAN_MS) {
      warnedAt.set(window, now)
      console.warn(`[shell] the chrome page still reads hidden after ${String(MAX_REPAIRS)} repairs in ${String(REPAIR_SPAN_MS)} ms; left as it is`)
    }
    return
  }
  repairs.set(window, [...recent, now])
  const shown = overlays.reshow()
  console.info(`[shell] the chrome page read hidden; showed ${shown.length === 0 ? 'no overlay' : shown.join(', ')} again (repair ${String(recent.length + 1)} of ${String(MAX_REPAIRS)})`)
}
