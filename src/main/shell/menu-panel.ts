// The main menu, a popover under the toolbar's menu button. Shares its view
// lifecycle with the other popovers (../permissions/popover-view.ts) and adds
// only what it lists (./menu-layout.ts) and what choosing an entry does.
import type { BaseWindow, View } from 'electron'
import { registerMenuIpc } from '../ipc/menu-ipc.js'
import { createPopoverView } from '../permissions/popover-view.js'
import type { PopoverAnchor } from '../permissions/popover-view.js'
import type { CommandId } from '../shortcuts/commands.js'
import type { ShortcutService } from '../shortcuts/shortcut-service.js'
import { menuItems } from './menu-layout.js'

export interface MenuPanel {
  toggle: (anchor: PopoverAnchor) => void
  close: () => void
  isOpen: () => boolean
}

export function createMenuPanel (
  win: BaseWindow,
  contentView: View,
  shortcuts: ShortcutService,
  runCommand: (id: CommandId) => void,
  dirname: string
): MenuPanel {
  const popover = createPopoverView(win, contentView, {
    dirname,
    entryPath: '/menu/',
    fallbackHtml: '../renderer/menu/index.html',
    preloadRelPath: '../preload/menu.js',
    urlArgName: 'orivon-menu-url',
    align: 'right',
    // The menu is a short, fixed list: it should show every entry, not
    // scroll a long one -- so its only real cap is the room below the
    // toolbar's menu button, which popoverBounds applies regardless.
    maxHeight: Number.POSITIVE_INFINITY,
    registerIpc: (webContents, onContentHeight) => {
      registerMenuIpc(webContents, {
        items: () => menuItems(shortcuts),
        run: (id) => {
          popover.close()
          runCommand(id)
        }
      }, onContentHeight)
      return () => {}
    }
  })
  return { toggle: (anchor) => { popover.toggle(anchor, []) }, close: popover.close, isOpen: popover.isOpen }
}
