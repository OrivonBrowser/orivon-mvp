// The notices for pointer lock and keyboard lock. Electron grants both with
// no browser UI of its own: nothing tells the person that Escape brings the
// cursor back, or that a fullscreen page holding the keyboard takes a held
// Escape, not a press. Fullscreen's own notice is window.ts's.
import type { WebContents } from 'electron'
import { windowShowing } from './showing-window.js'
import { NOTICES, noticeForWindow, type NoticeText } from './window-notice.js'

export type ExclusiveAccess = 'fullscreen' | 'pointerLock' | 'keyboardLock'

/** Which notice a grant needs, if any. In fullscreen, Escape leaves the
 * pointer lock and fullscreen together, which the fullscreen notice already
 * says; keyboard lock only takes effect in fullscreen. */
export function exclusiveAccessNotice (access: ExclusiveAccess, inFullscreen: boolean): NoticeText | null {
  if (access === 'pointerLock') return inFullscreen ? null : NOTICES.pointerLock
  if (access === 'keyboardLock') return inFullscreen ? NOTICES.holdEscToExitFullscreen : null
  return null
}

const watched = new WeakSet<WebContents>()
const inFullscreen = new WeakSet<WebContents>()

/** Starts following a tab's HTML fullscreen. Called from the fullscreen
 * grant, which Chromium always asks for before the page enters, so the
 * enter event that follows is never missed. */
function watchFullscreen (contents: WebContents): void {
  if (watched.has(contents)) return
  watched.add(contents)
  contents.on('enter-html-full-screen', () => { inFullscreen.add(contents) })
  contents.on('leave-html-full-screen', () => { inFullscreen.delete(contents) })
}

/** Called by the permission gate as it grants one of the three. */
export function noteExclusiveAccess (contents: WebContents, access: ExclusiveAccess): void {
  if (access === 'fullscreen') {
    watchFullscreen(contents)
    return
  }
  const text = exclusiveAccessNotice(access, inFullscreen.has(contents))
  if (text === null) return
  const win = windowShowing(contents)
  if (win !== undefined) noticeForWindow(win).show(text)
}
