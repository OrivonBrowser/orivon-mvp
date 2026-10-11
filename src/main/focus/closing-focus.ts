// macOS only: contents that close while they hold the keyboard (a popover's page destroyed while it shows) leave the
// window's first responder on a native view being torn down, and the main process dies on the next event: SIGSEGV
// inside Electron Framework, measured on Electron 44 and macOS 15. Handing the keyboard to the window's chrome as
// the contents begin to close prevents it. Linux and Windows do not crash there, and keep their focus as it is.
import type { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'

type Closing = Pick<WebContents, 'isDestroyed' | 'isFocused'>
type Chrome = Pick<WebContents, 'isDestroyed' | 'focus'>

/**
 * Gives the keyboard to the chrome of the window `contents` is in, when `contents` starts to close while holding it.
 * `close` is the event Electron emits before it destroys the contents (`destroyed` comes after, too late); it is
 * not in Electron's typings.
 */
export function handOffFocusOnClose<T extends Closing> (contents: T, chromeOf: (contents: T) => Chrome | undefined): void {
  ;(contents as unknown as EventEmitter).on('close', () => {
    if (contents.isDestroyed() || !contents.isFocused()) return
    const chrome = chromeOf(contents)
    if (chrome === undefined || (chrome as unknown) === contents || chrome.isDestroyed()) return
    chrome.focus()
  })
}
