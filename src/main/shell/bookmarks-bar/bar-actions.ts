// The chrome's calls about the bookmarks bar (`shell.act`). Every payload comes from a renderer: each field is
// checked here, and an id is looked up in the store, never trusted to carry an address.
import type { ChromeAction } from '../chrome-actions.js'
import { barItemsOf } from './bar-items.js'
import { asAnchor } from '../bookmark-bubble/edit-action.js'
import { showBarMenu } from './bar-menu-runner.js'
import { asFrom } from './folder-model.js'
import { clickOnFolder, FOLDER_OVERLAY } from './folder-overlay.js'
import { isClickDisposition, openBookmark } from './open-bookmark.js'

const record = (payload: unknown): Record<string, unknown> => typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** No payload: the bar's items, for a chrome that has just started. */
export const barItems: ChromeAction = (_payload, { services }) => barItemsOf(services.bookmarks)

/** `{ id, disposition }`. */
export const barOpen: ChromeAction = (payload, ctx) => {
  const { id, disposition } = record(payload)
  if (typeof id !== 'string' || !isClickDisposition(disposition)) return
  openBookmark(ctx, id, disposition)
}

/** `{ id: string | null, x, y, anchor? }`: the right-click menu of one item, or of the empty bar. `anchor` is the item's rectangle, where Edit and Rename put their bubble. */
export const barMenu: ChromeAction = (payload, ctx) => {
  const { id, x, y, anchor } = record(payload)
  if ((id !== null && typeof id !== 'string') || !isNumber(x) || !isNumber(y)) return
  showBarMenu(ctx, id, { x, y }, asAnchor(anchor))
}

/** `{ id, parent, index? }`: drag reorder and drop into a folder. The index is a position in the parent's list as it stands; none appends. */
export const barMove: ChromeAction = (payload, { services }) => {
  const { id, parent, index } = record(payload)
  if (typeof id !== 'string' || typeof parent !== 'string') return
  if (index !== undefined && (!isNumber(index) || index < 0)) return
  services.bookmarks.move([id], parent, index)
}

/** `{ id, anchor, from? }`: the folder's menu, closed again by a second click and switched by a click on another folder. */
export const barFolder: ChromeAction = (payload, { window, services }) => {
  const { id, anchor, from } = record(payload)
  const box = record(anchor)
  const start = asFrom(from)
  if (start === null) return
  if (typeof id !== 'string' || ![box['x'], box['y'], box['width'], box['height']].every(isNumber)) return
  if (services.bookmarks.node(id)?.kind !== 'folder') return
  const rect = { x: box['x'] as number, y: box['y'] as number, width: box['width'] as number, height: box['height'] as number }
  const what = clickOnFolder(window, id)
  if (what === 'close') window.overlays.close(FOLDER_OVERLAY)
  else if (what === 'show') window.overlays.show(FOLDER_OVERLAY, rect, start === undefined ? { id } : { id, from: start })
}
