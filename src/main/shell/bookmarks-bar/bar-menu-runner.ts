// Shows the bar's native menu: builds the model from the store, wires each item to what it does, and pops it up.
import { Menu, clipboard } from 'electron'
import { commandById } from '../../shortcuts/commands.js'
import { barMenuTemplate } from './bar-menu.js'
import type { BarMenuTarget } from './bar-menu.js'
import { bookmarksBarShown } from './bar-visibility.js'
import { openBookmarkEdit } from '../bookmark-bubble/open-edit.js'
import { openAll, openableIn, openBookmark } from './open-bookmark.js'
import type { OverlayAnchor } from '../../overlays/overlay-types.js'
import type { WindowContext } from '../window-context.js'

/**
 * Pops up the menu for bookmark `id` (null: the empty bar). `at` is in chrome coordinates; without it the menu opens at
 * the pointer, for a caller that is not the chrome and does not know where its own view sits in the window.
 */
export function showBarMenu (ctx: WindowContext, id: string | null, at: { x: number, y: number } | undefined, anchor?: OverlayAnchor): void {
  const { window, services } = ctx
  const node = id === null ? undefined : services.bookmarks.node(id)
  if (id !== null && node === undefined) return
  const target: BarMenuTarget = node === undefined ? { kind: 'bar' } : node.kind === 'folder' ? { kind: 'folder', pages: openableIn(ctx, node.id).length } : { kind: 'url' }
  // Under the item the menu was asked for; the empty bar has none, so the sheet opens where the click was.
  const here: OverlayAnchor = anchor ?? { x: at?.x ?? 0, y: at?.y ?? 0, width: 0, height: 0 }
  const parent = node?.parent ?? 'bar'
  const open = (disposition: Parameters<typeof openBookmark>[2]) => () => { if (node !== undefined) openBookmark(ctx, node.id, disposition) }
  const template = barMenuTemplate({ target, isPrivate: services.isPrivate, barShown: bookmarksBarShown(services), parentIsBar: parent === 'bar' }, {
    openInTab: open('background'),
    openInWindow: open('window'),
    openInPrivate: open('private'),
    openAll: () => { if (node !== undefined) openAll(ctx, node.id) },
    edit: () => { if (node !== undefined) openBookmarkEdit(ctx, { id: node.id, anchor: here, mode: 'edit' }) },
    rename: () => { if (node !== undefined) openBookmarkEdit(ctx, { id: node.id, anchor: here, mode: 'rename-folder' }) },
    addFolder: () => { openBookmarkEdit(ctx, { id: parent, anchor: here, mode: 'new-folder' }) },
    moveToBar: () => { if (node !== undefined) services.bookmarks.move([node.id], 'bar') },
    copyLink: () => { if (node?.url !== undefined) clipboard.writeText(node.url) },
    remove: () => { if (node !== undefined) services.bookmarks.remove([node.id]) },
    toggleBar: () => { services.commands.run('bookmarks.toggleBar', window) },
    openManager: commandById('bookmarks.open')?.pending === true ? undefined : () => { services.commands.run('bookmarks.open', window) }
  })
  if (window.window.isDestroyed()) return
  Menu.buildFromTemplate(template).popup(at === undefined ? { window: window.window } : { window: window.window, x: Math.round(at.x), y: Math.round(at.y) })
}
