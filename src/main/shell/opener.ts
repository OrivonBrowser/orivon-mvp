// What a second start of this profile makes the running browser do (index.ts's `opener`): bring its window forward
// with the addresses it was given, open a new window, or start a private session. `focused` is
// `WindowRegistry.focused()`'s result: the window the person is using, or undefined when none is open.
import type { LaunchRequest } from '../launch/launch-request.js'
import { openFromBrowser } from './open-from-browser.js'
import type { ShellWindow } from './window-registry.js'
import type { ShellWindowOptions } from './window-options.js'

export interface LaunchActions {
  /** Opens a window, which shows itself once ready rather than being shown here before it can paint. */
  readonly create: (options: ShellWindowOptions) => void
  readonly openPrivate: (urls: readonly string[]) => boolean
  /** A kiosk has no chrome to reach a second window or a private session from: it only shows what it has. */
  readonly kiosk: boolean
}

/** The addresses take the place of a new window's new-tab page, which it keeps when there are none. */
function openWindow (urls: readonly string[], create: LaunchActions['create']): void {
  create(urls.length === 0 ? {} : { first: (tabs) => { for (const url of urls) openFromBrowser(tabs, url) } })
}

/** `open` reuses `focused`, and opens a window only when none exists. `window` always opens one and leaves the others as they are. */
export function answerLaunch (request: LaunchRequest, focused: ShellWindow | undefined, { create, openPrivate, kiosk }: LaunchActions): void {
  if (!kiosk && request.kind === 'window') {
    openWindow(request.urls, create)
    return
  }
  if (!kiosk && request.kind === 'private') {
    openPrivate(request.urls)
    return
  }
  if (focused === undefined) {
    openWindow(request.urls, create)
    return
  }
  if (focused.window.isMinimized()) focused.window.restore()
  focused.window.show()
  focused.window.focus()
  for (const url of request.urls) openFromBrowser(focused.tabs, url)
}
