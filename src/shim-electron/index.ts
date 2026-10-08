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
import { createDesktopCapturer, type LegacyNavigator } from './desktop-capturer.js'
import { createClipboard } from './clipboard.js'
import { createDialog } from './dialog.js'
import { installFileUrlRewrite } from './file-urls.js'
import type { FileUrlScope } from './file-urls.js'
import { createIpc } from './ipc.js'
import { createSafeStorage } from './safe-storage.js'
import { createShell } from './shell.js'
import { BrowserWindow, Menu, Tray } from './desktop-shell.js'
import { notConsidered, refusingProxy, unimplementedMember, withUnimplementedFallback } from './unimplemented.js'
import type { Orivon } from '../contracts/capability-api.js'

export { ElectronShimError } from './errors.js'
export type { ElectronShimReason } from './errors.js'
export type { ElectronApp } from './app.js'
export type { ClipboardDeps, ElectronClipboard } from './clipboard.js'
export type { ElectronShell, ShellDeps } from './shell.js'
export type { DesktopCapturerSource, ElectronDesktopCapturer, ShimNativeImage, SourcesOptions } from './desktop-capturer.js'
export type { ElectronDialog, OpenDialogOptions, OpenDialogReturnValue } from './dialog.js'
export type { ElectronIpcMain, ElectronIpcRenderer, IpcEvent, IpcHandler, IpcListener } from './ipc.js'
export type { DecryptStringAsyncReturnValue, ElectronSafeStorage } from './safe-storage.js'
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

// A ported app builds `file://` URLs to its own files (ADR-0070); see file-urls.ts.
installFileUrlRewrite(globalThis as FileUrlScope)

export const app = createApp(orivon)
export const dialog = createDialog(orivon)
export const safeStorage = createSafeStorage(orivon)
export const desktopCapturer = refusingProxy(createDesktopCapturer({
  mediaDevices: (globalThis as { navigator?: Navigator }).navigator?.mediaDevices,
  navigator: (globalThis as { navigator?: LegacyNavigator }).navigator,
  document: { createElement: ((tag: string) => document.createElement(tag)) as Document['createElement'] },
  random: () => crypto.randomUUID()
}), (prop) => notConsidered(`desktopCapturer.${prop}`))

// A worker has no document: its paste events are none, so readText answers ''.
export const clipboard = createClipboard({
  document: (globalThis as { document?: EventTarget }).document ?? new EventTarget(),
  navigator: (globalThis as { navigator?: Navigator }).navigator ?? {},
  warn: (message, error) => { console.warn(message, error) }
})
export const shell = createShell({
  open: (url, target, features) => (globalThis as unknown as { open: (...args: string[]) => unknown }).open(url, target, features)
})

const bus = createIpc()
export const ipcRenderer = bus.ipcRenderer
export const ipcMain = bus.ipcMain

/**
 * Real Electron's top-level surface this package has not implemented and
 * has not decided whether it will -- the names real ported apps reach for
 * most. Named individually, rather than left absent, so `import { session }
 * from 'electron'` resolves and `mod.session` (this package's own tests read
 * the module the same way) both throw a named `ElectronShimError` instead
 * of silently reading `undefined` -- the defect this file exists to close.
 * A name entirely outside this list still fails loudly, either at the point
 * a bundler resolves a named import against it or via the default export
 * below, never as a bare TypeError deep in a call.
 */
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
  app, dialog, safeStorage, ipcRenderer, ipcMain, BrowserWindow, Menu, Tray,
  shell, clipboard, session, protocol, webContents, nativeImage, screen,
  contextBridge, crashReporter, powerMonitor, systemPreferences,
  globalShortcut, nativeTheme, webFrame, desktopCapturer
})
