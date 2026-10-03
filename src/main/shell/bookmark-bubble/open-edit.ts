// How the bubble is opened: from the star, from Mod+D, from a bar item's menu, and the sheet for "Bookmark all tabs".
// The address and title of a new bookmark are the tab's own, read here in main; the chrome only says where the
// star is, because only it knows.
import type { OverlayAnchor } from '../../overlays/overlay-types.js'
import type { BookmarkNode } from '../../browsing/bookmark-types.js'
import { sendChromeEvent } from '../shell-events.js'
import type { TabState } from '../tab-types.js'
import type { WindowContext } from '../window-context.js'
import type { ShellWindow } from '../window-registry.js'
import { ALL_TABS_OVERLAY, EDIT_OVERLAY, lastFolderOf, markAdded, takeAdded } from './bubble-state.js'
import { editPayload, newestBookmarkOf, tabsToBookmark } from './edit-model.js'
import type { EditMode } from './edit-model.js'

/** The chrome module that answers with the star's rectangle. */
export const STAR_MODULE = 'bookmark-star'

export interface OpenEdit {
  /** Where the bubble goes; none puts it at the toolbar's right end. */
  anchor?: OverlayAnchor | undefined
  /** A bookmark or folder to edit; none means the active page. For `new-folder`, the folder the new one goes in. */
  id?: string | undefined
  mode?: Extract<EditMode, 'edit' | 'rename-folder' | 'new-folder'> | undefined
  /** The star's own click: add the page first if it is not saved. */
  add?: boolean | undefined
  /** A second click on the star closes the bubble it opened. */
  toggle?: boolean | undefined
  /** The time of the star's press this click completes, so a held click that closed the bubble does not reopen it. */
  pressedAt?: number | undefined
}

/** The tab that may be bookmarked: one showing a site, as the star's own rule has it. */
export function bookmarkableTab (window: ShellWindow): TabState | undefined {
  const { tabs, activeTabId } = window.tabs.getState()
  const active = tabs.find((tab) => tab.id === activeTabId)
  return active === undefined || active.isNewTab || active.isInternal || active.url === '' ? undefined : active
}

/** Saves the active page in the folder last used (the bar at first) unless it is saved already. Returns the bookmark and whether it is new. */
export function bookmarkActivePage (ctx: WindowContext): { node: BookmarkNode, added: boolean } | undefined {
  const { window, services } = ctx
  const active = bookmarkableTab(window)
  if (active === undefined) return undefined
  const existing = newestBookmarkOf(services.bookmarks, active.url)
  if (existing !== undefined) return { node: existing, added: false }
  const node = services.bookmarks.addUrl({
    url: active.url,
    title: active.title.length > 0 ? active.title : active.url,
    favicon: window.tabs.faviconFor(active.id),
    parent: lastFolderOf(services.bookmarks)
  })
  if (node === null) return undefined
  markAdded(window, node.id)
  return { node, added: true }
}

/** Mod+D: save the page if it is new, and ask the chrome where the star is to put the bubble under it. Never removes. */
export function starCommand (ctx: WindowContext): void {
  if (bookmarkableTab(ctx.window) === undefined) return
  if (bookmarkActivePage(ctx) === undefined) return
  sendChromeEvent(ctx.window, STAR_MODULE, { open: true })
}

export function openBookmarkEdit (ctx: WindowContext, options: OpenEdit): void {
  const { window, services } = ctx
  let id = options.id
  let mode: EditMode = options.mode ?? 'edit'
  if (id === undefined) {
    const tab = bookmarkableTab(window)
    if (tab === undefined) return
    const node = options.add === true ? bookmarkActivePage(ctx)?.node : newestBookmarkOf(services.bookmarks, tab.url)
    if (node === undefined) return
    id = node.id
  }
  // A bookmark that is gone, or a folder the mode cannot edit, opens nothing rather than an empty card.
  if (editPayload(services.bookmarks, mode, id) === undefined) return
  if (mode === 'edit' && takeAdded(window, id)) mode = 'added'
  const payload = { mode, id }
  if (options.toggle === true) window.overlays.toggle(EDIT_OVERLAY, options.anchor, payload, options.pressedAt)
  else window.overlays.show(EDIT_OVERLAY, options.anchor, payload)
}

/** "Bookmark all tabs": the sheet, unless no tab has a site. */
export function openBookmarkAllTabs (ctx: WindowContext): void {
  const { window } = ctx
  const eligible = tabsToBookmark(window.tabs.getState().tabs, () => null)
  if (eligible.length === 0) return
  window.overlays.show(ALL_TABS_OVERLAY)
}
