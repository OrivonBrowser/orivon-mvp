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
 * URL, which is not an attack and must keep working; a popup or an
 * isolated context (this function's other caller) has no such exception
 * and passes nothing.
 *
 * ONLY AFTER THE FIRST LOAD: a `loadURL`/`loadFile` call does not itself
 * fire `will-navigate` (Electron's own behaviour, confirmed empirically
 * before this file existed), so attaching these listeners before that call
 * would be no more effective than attaching them after -- and after is
 * simpler, since the destination the first load lands on is exactly what
 * `allowedUrl` names.
 */
export function lockNavigation (webContents: WebContents, allowedUrl?: string): void {
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const preventNavigation = (event: { preventDefault: () => void, url: string }): void => {
    if (event.url === allowedUrl) return
    event.preventDefault()
  }
  webContents.on('will-navigate', preventNavigation)
  webContents.on('will-redirect', preventNavigation)
  webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame && event.url !== allowedUrl) event.preventDefault()
  })
}
