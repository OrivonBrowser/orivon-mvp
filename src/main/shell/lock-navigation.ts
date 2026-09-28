// One `WebContentsView`'s navigation lockdown -- lifted out of
// `../sessions/web-context-host.ts`'s own local closure (Rule 3) once a
// second caller (this file's own `window.ts`) needed the identical guard
// for the chrome view and its popups. A privileged preload
// (`contextBridge.exposeInMainWorld`) is only as safe as the document it is
// attached to: Electron re-injects a preload on every navigation, so a view
// that could ever be navigated to attacker content would hand that content
// the same bridge the trusted page holds.

import type { WebContents } from 'electron'

/**
 * Refuses every navigation and every popup on `webContents`. `allowedUrl`,
 * when given, is the one destination `will-navigate`/`will-redirect` still
 * let through -- Vite's dev-server HMR client reloads the page at its own
 * URL, which is not an attack and must keep working. Omitted entirely
 * refuses EVERY navigation, no exception: a popup or an isolated context
 * (this function's other caller) never legitimately navigates at all, and
 * `event.url` on a real navigation is never `undefined`, so comparing
 * against an also-`undefined` `allowedUrl` must not read as a match.
 *
 * `webContents.loadURL`/`loadFile` does not itself fire `will-navigate`
 * (Electron's own behaviour, confirmed empirically) -- attaching these
 * listeners is therefore safe at any point relative to a caller's own
 * first `loadURL` call; neither ordering blocks that call.
 */
export function lockNavigation (webContents: WebContents, allowedUrl?: string): void {
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const preventNavigation = (event: { preventDefault: () => void, url: string }): void => {
    if (allowedUrl !== undefined && event.url === allowedUrl) return
    event.preventDefault()
  }
  webContents.on('will-navigate', preventNavigation)
  webContents.on('will-redirect', preventNavigation)
  webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame) return
    if (allowedUrl !== undefined && event.url === allowedUrl) return
    event.preventDefault()
  })
}
