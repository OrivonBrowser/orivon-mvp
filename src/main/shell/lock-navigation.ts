// One `WebContentsView`'s navigation lockdown. A privileged preload
// (`contextBridge.exposeInMainWorld`) is only as safe as the document it is
// attached to: Electron re-injects a preload on every navigation, so a view
// that could ever be navigated to attacker content would hand that content
// the same bridge the trusted page holds.

import type { WebContents } from 'electron'

/**
 * Refuses every popup, and every navigation but one to `allowedUrl`. The
 * chrome view and each popup pass their own URL, so the page may load its
 * own document again; an isolated context passes none and never navigates
 * at all. `event.url` on a real navigation is never `undefined`, so an
 * omitted `allowedUrl` must never read as a match. Each refusal is logged,
 * since a view left blank by one would otherwise give no sign.
 *
 * `webContents.loadURL`/`loadFile` does not itself fire `will-navigate`
 * (Electron's own behaviour, confirmed empirically), so attaching these
 * listeners before a caller's first `loadURL` blocks nothing it does on
 * purpose. `will-redirect` does fire for such a load if it redirects.
 */
export function lockNavigation (webContents: WebContents, allowedUrl?: string): void {
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const isAllowed = (url: string): boolean => allowedUrl !== undefined && url === allowedUrl
  const refuse = (event: { preventDefault: () => void, url: string }): void => {
    if (isAllowed(event.url)) return
    console.warn('[lock-navigation] refused', event.url)
    event.preventDefault()
  }
  webContents.on('will-navigate', refuse)
  webContents.on('will-redirect', refuse)
  webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) refuse(event)
  })
}
