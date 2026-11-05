import type { ChromeAction } from '../chrome-actions.js'
import type { ShellWindow } from '../window-registry.js'

/** How many times a window is repaired within `REPAIR_SPAN_MS`; past that, one more repair is tried when the span ends. */
const MAX_REPAIRS = 3
const REPAIR_SPAN_MS = 2_000
/** How long after the repair at the end of the span the chrome page is read once more. */
const SETTLE_MS = 300

const repairs = new WeakMap<ShellWindow, number[]>()
/** Windows with the repair at the end of a span set: the page reports hidden often while it stays hidden, and one is enough. */
const retrying = new WeakSet<ShellWindow>()

const meantToBeShown = ({ window: win, chrome }: ShellWindow): boolean => !win.isDestroyed() && win.isVisible() && !win.isMinimized() && chrome.getVisible()

async function readsHidden ({ chrome }: ShellWindow): Promise<boolean> {
  try {
    return await chrome.webContents.executeJavaScript('document.visibilityState') === 'hidden'
  } catch {
    return false
  }
}

function repair (window: ShellWindow, now: number): void {
  const recent = (repairs.get(window) ?? []).filter((at) => now - at < REPAIR_SPAN_MS)
  repairs.set(window, [...recent, now])
  const shown = window.overlays.reshow()
  console.info(`[shell] the chrome page read hidden; showed ${shown.length === 0 ? 'no overlay' : shown.join(', ')} again (repair ${String(recent.length + 1)} of ${String(MAX_REPAIRS)})`)
}

/** The repair at the end of the span: the chrome page is asked, because it reports a change to hidden and never the
 * hidden state that went on. One that still reads hidden is repaired once more and read again, and a log line says if
 * it is left hidden. */
async function repairAtEndOfSpan (window: ShellWindow): Promise<void> {
  retrying.delete(window)
  if (!meantToBeShown(window) || !await readsHidden(window)) return
  repair(window, Date.now())
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
  if (meantToBeShown(window) && await readsHidden(window)) console.warn('[shell] the chrome page still reads hidden after the repair at the end of the span; left as it is')
}

/** The chrome page reports that it reads hidden. When the window is on screen and the chrome view is meant to be shown,
 * the page is wrong, not the window: the overlays are hidden and shown again in one turn, which makes Chromium work out
 * what covers what a second time (README.md's Design notes). Each repair is a line of the log, which a bug report
 * carries, and so is a chrome that three repairs did not bring back. */
export const chromeHidden: ChromeAction = (_payload, { window }) => {
  if (!meantToBeShown(window)) return
  const now = Date.now()
  const recent = (repairs.get(window) ?? []).filter((at) => now - at < REPAIR_SPAN_MS)
  if (recent.length < MAX_REPAIRS) {
    repair(window, now)
    return
  }
  if (retrying.has(window)) return
  retrying.add(window)
  console.warn(`[shell] the chrome page read hidden again after ${String(MAX_REPAIRS)} repairs in ${String(REPAIR_SPAN_MS)} ms; one more repair is set for the end of that span`)
  const timer = setTimeout(() => {
    repairAtEndOfSpan(window).catch((error: unknown) => { console.error('[shell] the repair of the chrome page at the end of the span failed:', error) })
  }, Math.max(0, (recent[0] ?? now) + REPAIR_SPAN_MS - now) + 1)
  timer.unref()
}
