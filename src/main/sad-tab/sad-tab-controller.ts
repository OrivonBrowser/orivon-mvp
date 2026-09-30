// Decides, for one window, whether the sad-tab card is up: it is for the active tab only, and only while that tab's
// page is crashed or not answering. A tab that has trouble in the background shows nothing over the page the person is
// reading; it gets the card the moment it is activated.
import type { WebContents } from 'electron'
import type { TabLifecycle } from '../shell/tab-lifecycle.js'
import type { ShellWindow } from '../shell/window-registry.js'
import { troubleOf } from './sad-tab-state.js'

export const SAD_TAB_OVERLAY = 'sad-tab'

/** What the card now open in a window is about, so a state push that changes nothing does not re-show it and take focus back. */
const shown = new WeakMap<ShellWindow, string>()

export function cardClosed (window: ShellWindow): void {
  shown.delete(window)
}

/** Opens, updates or closes the window's card to match its active tab. */
export function syncSadTab (window: ShellWindow): void {
  if (window.window.isDestroyed()) return
  const wc = window.tabs.activeWebContents()
  const id = wc === undefined ? null : window.tabs.findTabIdByWebContents(wc)
  const record = id === null ? undefined : window.tabs.record(id)
  const trouble = record === undefined ? null : troubleOf(record)
  if (id === null || trouble === null) {
    if (window.overlays.isOpen(SAD_TAB_OVERLAY)) window.overlays.close(SAD_TAB_OVERLAY)
    return
  }
  const key = `${id}:${trouble.kind}`
  if (window.overlays.isOpen(SAD_TAB_OVERLAY) && shown.get(window) === key) return
  shown.set(window, key)
  window.overlays.show(SAD_TAB_OVERLAY, undefined, { id })
}

const watched = new WeakSet<TabLifecycle>()

/** Once per process, when the first tab is wired: a tab that becomes the active one gets its card. It waits a turn,
 * because the activation's own state push closes whatever belonged to the tab being left, and must not close this. */
export function watchActivations (lifecycle: TabLifecycle, windowOf: (contents: WebContents) => ShellWindow | undefined): void {
  if (watched.has(lifecycle)) return
  watched.add(lifecycle)
  lifecycle.subscribe({
    tabActivated: (contents) => {
      setTimeout(() => {
        if (contents.isDestroyed()) return
        const window = windowOf(contents)
        if (window !== undefined) syncSadTab(window)
      }, 0)
    }
  })
}
