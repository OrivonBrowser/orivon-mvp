import { BaseWindow } from 'electron'

/** The window `contents` is on screen in, or undefined. Only the active tab's
 * view is attached to a window (tabs.ts detaches the rest), so a background
 * tab has none: a question or notice for it would appear over another page. */
export function windowShowing (contents: object): BaseWindow | undefined {
  return BaseWindow.getAllWindows().find((win) => !win.isDestroyed() &&
    win.contentView.children.some((view) => 'webContents' in view && view.webContents === contents))
}
