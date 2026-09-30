// What the three find commands do to a window, whichever way they were asked:
// the key, the menu, or a key pressed inside the bar itself.
import type { ShellWindow } from '../shell/window-registry.js'
import { findWindowFor, FIND_OVERLAY } from './find-window.js'

/** Opens the bar on the active tab. Opened already, it takes focus back and selects its text. */
export function openFind (target: ShellWindow): void {
  if (target.tabs.activeWebContents() === undefined) return
  target.overlays.show(FIND_OVERLAY)
}

/** The next or previous match. With the bar closed it opens with the last query and steps once the count is in. */
export function findStep (target: ShellWindow, forward: boolean): void {
  if (target.tabs.activeWebContents() === undefined) return
  if (target.overlays.isOpen(FIND_OVERLAY)) {
    findWindowFor(target)?.step(forward)
    return
  }
  target.overlays.show(FIND_OVERLAY, undefined, { step: forward })
}
