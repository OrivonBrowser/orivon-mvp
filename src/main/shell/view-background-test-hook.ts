// Test-only state Electron 44 has no getter for, keyed by a view's own
// webContents id -- reachable only from Node code already running in this
// process (Playwright's ElectronApplication.evaluate()), never from any
// renderer-reachable surface -- same gate and reasoning as
// ../extensions/store-test-hook.ts.
declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const SEAM_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

declare global {
  // Both undefined except inside a process this hook actually recorded into.
  var __orivonDevViewBackgrounds: Map<number, string> | undefined
  var __orivonDevPopoverShown: Set<number> | undefined
}

/** What background colour a view was just painted, before an e2e test can
 * otherwise observe it: `View` has `setBackgroundColor`, no
 * `getBackgroundColor` (that getter exists only on `BaseWindow`/
 * `BrowserWindow` -- checked against node_modules/electron/electron.d.ts).
 * Call right after every `setBackgroundColor` the white-flash fix added
 * (tab-view.ts's `makeTabView`, popover-view.ts's `construct()`/theme
 * updates). */
export function recordViewBackground (webContentsId: number, color: string): void {
  if (!SEAM_ENABLED) return
  globalThis.__orivonDevViewBackgrounds ??= new Map()
  globalThis.__orivonDevViewBackgrounds.set(webContentsId, color)
}

/** Whether a popover is currently attached to the screen -- an e2e test
 * cannot tell this from `webContents.getAllWebContents()` alone once
 * popover-view.ts's `warm` keeps a hidden popup's webContents alive rather
 * than destroying it, the way a non-warm popup's close still does. Call from
 * popover-view.ts's `show()` (true) and `hide()` (false). */
export function recordPopoverShown (webContentsId: number, shown: boolean): void {
  if (!SEAM_ENABLED) return
  globalThis.__orivonDevPopoverShown ??= new Set()
  if (shown) globalThis.__orivonDevPopoverShown.add(webContentsId)
  else globalThis.__orivonDevPopoverShown.delete(webContentsId)
}
