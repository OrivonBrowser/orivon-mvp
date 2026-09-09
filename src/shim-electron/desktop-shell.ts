// BrowserWindow, Menu and Tray -- the desktop-shell row compatibility-
// matrix.md Table 2 marks out of scope rather than covers. An Orivon app
// runs inside a tab the shell already owns; opening its own OS window,
// menu or tray icon is not a missing feature to build toward, it is the
// boundary in-tab-only architecture draws. Every entry point below throws
// immediately rather than returning an object that silently does nothing,
// so a porting developer sees the boundary the first time they hit it.

import { refuse } from './errors.js'

function desktopShellRefusal (api: string): never {
  throw refuse(api, 'desktop-shell',
    `${api} is the desktop-shell surface, out of scope for an Orivon app by design ` +
    "(compatibility-matrix.md Table 2). An Orivon app runs inside the browser's own tab; it " +
    'does not open its own OS window, menu or tray icon.')
}

export class BrowserWindow {
  constructor () { desktopShellRefusal('BrowserWindow') }
  static getAllWindows (): never { desktopShellRefusal('BrowserWindow.getAllWindows') }
  static getFocusedWindow (): never { desktopShellRefusal('BrowserWindow.getFocusedWindow') }
}

export class Menu {
  constructor () { desktopShellRefusal('Menu') }
  static buildFromTemplate (_template?: readonly unknown[]): never { desktopShellRefusal('Menu.buildFromTemplate') }
  static setApplicationMenu (_menu?: Menu | null): never { desktopShellRefusal('Menu.setApplicationMenu') }
  static getApplicationMenu (): never { desktopShellRefusal('Menu.getApplicationMenu') }
}

export class Tray {
  constructor () { desktopShellRefusal('Tray') }
}
