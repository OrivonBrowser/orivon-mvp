// The `electron` module compatibility package (compatibility-matrix.md Table
// 2, family 2) -- what a ported Electron app's `require('electron')` /
// `import ... from 'electron'` resolves to inside an Orivon app tab. Wiring
// this module specifier to this file is the renderer bundler alias map
// (electron.vite.config.ts's `renderer.resolve.alias`), owned by the `shim`
// stream -- see README.md's Design notes for why that is a parked
// coordination point rather than an edit made here.
//
// Reads `window.orivon` (the preload's contextBridge surface) exactly once,
// at import time -- by the time an app's own script runs `import 'electron'`,
// the preload that installs `window.orivon` has already run, the same
// ordering every other page-facing Orivon consumer already relies on.

import { createApp } from './app.js'
import { createDialog } from './dialog.js'
import { createIpc } from './ipc.js'
import { BrowserWindow, Menu, Tray } from './desktop-shell.js'
import { unimplementedMember, withUnimplementedFallback } from './unimplemented.js'
import type { Orivon } from '../contracts/capability-api.js'

export { ElectronShimError } from './errors.js'
export type { ElectronShimReason } from './errors.js'
export type { ElectronApp } from './app.js'
export type { ElectronDialog, OpenDialogOptions, OpenDialogReturnValue } from './dialog.js'
export type { ElectronIpcMain, ElectronIpcRenderer, IpcEvent, IpcHandler, IpcListener } from './ipc.js'
export { BrowserWindow, Menu, Tray } from './desktop-shell.js'

/** Reads the real `orivon` global -- `window` and `globalThis` are the same object in a main-world script. */
export function getOrivon (): Orivon {
  const found = (globalThis as { orivon?: Orivon }).orivon
  if (found === undefined) {
    throw new Error(
      "the electron compatibility shim requires window.orivon, which only exists inside an " +
      'Orivon app tab -- see src/shim-electron/README.md.'
    )
  }
  return found
}

const orivon = getOrivon()

export const app = createApp(orivon)
export const dialog = createDialog(orivon)

const bus = createIpc()
export const ipcRenderer = bus.ipcRenderer
export const ipcMain = bus.ipcMain

/**
 * Real Electron's top-level surface this package has not implemented and
 * has not decided whether it will -- the names real ported apps reach for
 * most. Named individually, rather than left absent, so `import { shell }
 * from 'electron'` resolves and `mod.shell` (this package's own tests read
 * the module the same way) both throw a named `ElectronShimError` instead
 * of silently reading `undefined` -- the defect this file exists to close.
 * A name entirely outside this list still fails loudly, either at the point
 * a bundler resolves a named import against it or via the default export
 * below, never as a bare TypeError deep in a call.
 */
export const shell = unimplementedMember('shell')
export const clipboard = unimplementedMember('clipboard')
export const session = unimplementedMember('session')
export const protocol = unimplementedMember('protocol')
export const webContents = unimplementedMember('webContents')
export const nativeImage = unimplementedMember('nativeImage')
export const screen = unimplementedMember('screen')
export const contextBridge = unimplementedMember('contextBridge')
export const crashReporter = unimplementedMember('crashReporter')
export const powerMonitor = unimplementedMember('powerMonitor')
export const systemPreferences = unimplementedMember('systemPreferences')
export const globalShortcut = unimplementedMember('globalShortcut')
export const nativeTheme = unimplementedMember('nativeTheme')
export const webFrame = unimplementedMember('webFrame')
export const desktopCapturer = unimplementedMember('desktopCapturer')

/**
 * The same surface as one object, for `import electron from 'electron'` --
 * a real ES module namespace (what every named export above sits on) cannot
 * be made to throw for a name it never declared, but a default export's
 * value can be anything, including a Proxy. This is the one place the
 * refusal is genuinely total rather than limited to the curated list above:
 * a name this package has never even heard of still throws here, read off
 * `electron`'s default export, instead of resolving to `undefined`.
 */
export default withUnimplementedFallback({
  app, dialog, ipcRenderer, ipcMain, BrowserWindow, Menu, Tray,
  shell, clipboard, session, protocol, webContents, nativeImage, screen,
  contextBridge, crashReporter, powerMonitor, systemPreferences,
  globalShortcut, nativeTheme, webFrame, desktopCapturer
})
