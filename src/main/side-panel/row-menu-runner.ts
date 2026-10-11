// Pops a row's menu up at the pointer and puts a link on the clipboard: the two calls the pure menu needs from Electron.
import { Menu, clipboard } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import type { ShellWindow } from '../shell/window-registry.js'

export function popupRowMenu (window: ShellWindow, template: MenuItemConstructorOptions[]): void {
  if (window.window.isDestroyed()) return
  Menu.buildFromTemplate(template).popup({ window: window.window })
}

export function copyLink (url: string): void {
  clipboard.writeText(url)
}
