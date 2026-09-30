// Shows the bar's native menu: builds the model from the store, wires each item to what it does, and pops it up.
import { Menu, clipboard } from 'electron'
import { barMenuTemplate } from './bar-menu.js'
import type { BarMenuTarget } from './bar-menu.js'
import { bookmarksBarShown } from './bar-visibility.js'
import { openAll, openableIn, openBookmark } from './open-bookmark.js'
import type { WindowContext } from '../window-context.js'

/** Pops up the menu for bar item `id` (null: the empty bar) at chrome coordinates `x`, `y`. */
export function showBarMenu (ctx: WindowContext, id: string | null, at: { x: number, y: number }): void {
  const { window, services } = ctx
  const node = id === null ? undefined : services.bookmarks.node(id)
  if (id !== null && node === undefined) return
  const target: BarMenuTarget = node === undefined ? { kind: 'bar' } : node.kind === 'folder' ? { kind: 'folder', pages: openableIn(ctx, node.id).length } : { kind: 'url' }
  const open = (disposition: Parameters<typeof openBookmark>[2]) => () => { if (node !== undefined) openBookmark(ctx, node.id, disposition) }
  const template = barMenuTemplate({ target, isPrivate: services.isPrivate, barShown: bookmarksBarShown(services) }, {
    openInTab: open('background'),
    openInWindow: open('window'),
    openInPrivate: open('private'),
    openAll: () => { if (node !== undefined) openAll(ctx, node.id) },
    copyLink: () => { if (node?.url !== undefined) clipboard.writeText(node.url) },
    remove: () => { if (node !== undefined) services.bookmarks.remove([node.id]) },
    toggleBar: () => { services.commands.run('bookmarks.toggleBar', window) },
    openManager: () => { services.commands.run('bookmarks.open', window) }
  })
  if (window.window.isDestroyed()) return
  Menu.buildFromTemplate(template).popup({ window: window.window, x: Math.round(at.x), y: Math.round(at.y) })
}
