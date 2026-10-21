// Electron's `webContents.getFocusedWebContents()` asks every web contents `isFocused()`, and on an offscreen one
// (an app's child host, children/child-host.ts) that call dereferences a native view it does not have: SIGSEGV in
// the main process. Electron's own menus call it on every item click (`Menu._executeCommand`), so without this
// guard any menu click kills the browser while an app's child host runs. Offscreen contents never hold the keyboard.
import { webContents } from 'electron'
import type { WebContents } from 'electron'

type FocusQueryable = Pick<WebContents, 'isDestroyed' | 'getType' | 'isFocused'>

/** Electron's rule without the offscreen contents: the first focused one, or a focused `<webview>` inside it. */
export function focusedAmong<T extends FocusQueryable> (all: readonly T[]): T | null {
  let focused: T | null = null
  for (const contents of all) {
    if (contents.isDestroyed() || contents.getType() === 'offscreen' || !contents.isFocused()) continue
    focused ??= contents
    if (contents.getType() === 'webview') return contents
  }
  return focused
}

/** Replaces Electron's lookup for the whole process. Runs before the first menu can be built. */
export function installFocusedContentsGuard (module: Pick<typeof webContents, 'getAllWebContents' | 'getFocusedWebContents'> = webContents): void {
  module.getFocusedWebContents = () => focusedAmong(module.getAllWebContents())
}
