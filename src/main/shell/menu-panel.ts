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
import { MENU_SHOWN_CHANNEL } from '../channels.js'
import { MENU_POPOVER_BACKGROUND } from './theme-colors.js'

export interface MenuPanel {
  toggle: (anchor: PopoverAnchor) => void
  close: () => void
  isOpen: () => boolean
  /** Builds the menu's view now, if the toolbar button's own hover/focus
   * asked for it ahead of a click -- see popover-view.ts's own doc on why
   * this is not done at window construction. */
  prewarm: () => void
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
    background: MENU_POPOVER_BACKGROUND,
    // The menu is a short, fixed list: it should show every entry, not
    // scroll a long one -- so its only real cap is the room below the
    // toolbar's menu button, which popoverBounds applies regardless.
    maxHeight: Number.POSITIVE_INFINITY,
    // Static content, no per-open argument (which capability, which
    // origin -- unlike permissions/site-info): one view for the window's
    // whole lifetime removes the open delay a fresh WebContentsView (and a
    // fresh renderer process) would otherwise cost on every click.
    warm: true,
    // The warm view's own document is never reloaded, so this is what tells
    // it to re-fetch its list (a remapped shortcut, say) and reset its
    // scroll/focus state on every open, the way a fresh popup's first load
    // already does simply by starting over.
    onShow: (webContents) => { webContents.send(MENU_SHOWN_CHANNEL) },
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
  return { toggle: (anchor) => { popover.toggle(anchor, []) }, close: popover.close, isOpen: popover.isOpen, prewarm: popover.prewarm }
}
