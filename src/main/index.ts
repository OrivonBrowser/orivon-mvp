import { app, BaseWindow } from 'electron'
import { createShellWindow } from './window.js'

// Main and preload are CommonJS; only the renderer is ESM. This is
// electron-vite's default and it is kept deliberately, for one reason:
// sandboxed preload scripts have no ESM context at all -- they run as plain
// JavaScript and load electron via require. `sandbox: true` is non-negotiable
// here, so the preload must be CJS, and matching main to it avoids a
// two-format build for no gain.
//
// For the record, because it would otherwise be assumed: an ESM main process
// works fine. `import { app, ... } from 'electron'` was verified against
// Electron 44 on 2026-08-25 and returns the real API. If a future need for
// ESM in main appears, nothing here blocks it.
//
// BrowserWindow -> BaseWindow (build step 1, 2026-08-26): confirmed via
// live docs that BrowserWindow supports only a single full-size web view,
// while BaseWindow composes many (window-customization.md) -- required for
// the shell's chrome view + tab views. The webPreferences load-bearing note
// below now lives in window.ts and tabs.ts, next to where each view is
// actually constructed; still true, still worth reading there.
//
// A hookify rule rejects edits that weaken contextIsolation/sandbox/
// nodeIntegration/webSecurity anywhere in this tree (security-model.md T17
// and the block-insecure-webpreferences rule).

void app.whenReady().then(() => {
  createShellWindow()
  app.on('activate', () => {
    if (BaseWindow.getAllWindows().length === 0) createShellWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
