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
