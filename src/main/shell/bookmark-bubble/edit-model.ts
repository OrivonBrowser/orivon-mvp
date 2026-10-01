// What the bookmark bubble shows and what its requests change. Pure: the store and the clock are handed in, and
// every field of a command comes from a page, so each is checked here before the store sees it.
import type { BookmarkStore } from '../../browsing/bookmarks.js'
import type { BookmarkNode } from '../../browsing/bookmark-types.js'
import type { TabState } from '../tab-types.js'

export type EditStore = Pick<BookmarkStore, 'node' | 'path' | 'folders' | 'findByUrl' | 'addFolder' | 'update' | 'move' | 'remove' | 'importTree' | 'fillMissingFavicon'>

/** `added` and `edit` are one page's bookmark (just made, or opened to change); the folder modes have no folder picker. */
export type EditMode = 'added' | 'edit' | 'rename-folder' | 'new-folder'

export interface FolderChoice { id: string, title: string, depth: number }

export interface EditPayload {
  mode: EditMode
  /** The bookmark or folder being edited; absent for a new folder. */
  id?: string
  title: string
  /** The folder the bookmark sits in, or the one a new folder is made in. */
  parent: string
  folders: FolderChoice[]
}

export interface AllTabsPayload {
  count: number
  title: string
  parent: string
  folders: FolderChoice[]
}

export type EditCommand =
  | { type: 'save', id: string, title: string, parent: string, newFolder?: string }
  | { type: 'remove', id: string }
  | { type: 'saveFolder', id?: string, parent?: string, title: string }
  | { type: 'saveAll', title: string, parent: string }

const FIELDS: Readonly<Record<EditCommand['type'], readonly string[]>> = {
  save: ['type', 'id', 'title', 'parent', 'newFolder'],
  remove: ['type', 'id'],
  saveFolder: ['type', 'id', 'parent', 'title'],
  saveAll: ['type', 'title', 'parent']
}

/** A command as the page sent it, or undefined when its shape is wrong. Extra fields refuse the command. */
export function asEditCommand (value: unknown): EditCommand | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const fields = value as Record<string, unknown>
  const type = fields['type']
  if (typeof type !== 'string' || !Object.hasOwn(FIELDS, type)) return undefined
  if (Object.keys(fields).some((key) => !(FIELDS[type as EditCommand['type']]).includes(key))) return undefined
  const text = (key: string): string | undefined => typeof fields[key] === 'string' ? fields[key] : undefined
  const id = text('id'), title = text('title'), parent = text('parent'), newFolder = text('newFolder')
  if (fields['newFolder'] !== undefined && newFolder === undefined) return undefined
  switch (type) {
    case 'save': return id === undefined || title === undefined || parent === undefined ? undefined : newFolder === undefined ? { type, id, title, parent } : { type, id, title, parent, newFolder }
    case 'remove': return id === undefined ? undefined : { type, id }
    case 'saveFolder':
      if (title === undefined || (fields['id'] !== undefined && id === undefined) || (fields['parent'] !== undefined && parent === undefined)) return undefined
      return { type, title, ...(id === undefined ? {} : { id }), ...(parent === undefined ? {} : { parent }) }
    default: return title === undefined || parent === undefined ? undefined : { type: 'saveAll', title, parent }
  }
}

/** Whether `id` is a folder a person can file a bookmark in: the bar, Other bookmarks, or a folder under either. The reading list is not one. */
export function isFilingFolder (store: Pick<BookmarkStore, 'node' | 'path'>, id: string): boolean {
  const node = store.node(id)
  if (node?.kind !== 'folder') return false
  const root = store.path(id)[0]?.id
  return root === 'bar' || root === 'other'
}

export function folderChoices (store: Pick<BookmarkStore, 'folders'>): FolderChoice[] {
  return store.folders().map(({ node, depth }) => ({ id: node.id, title: node.title, depth }))
}

/** The bookmark of `url` that a star edits: the newest, which is the last added when several share the address. */
export function newestBookmarkOf (store: Pick<BookmarkStore, 'findByUrl'>, url: string): BookmarkNode | undefined {
  let newest: BookmarkNode | undefined
  for (const node of store.findByUrl(url)) if (newest === undefined || node.added >= newest.added) newest = node
  return newest
}

/** The bubble's content for node `id`, or undefined when it is gone or is not something this mode edits. For `new-folder`, `id` is the folder the new one goes in. */
export function editPayload (store: EditStore, mode: EditMode, id: string): EditPayload | undefined {
  const node = store.node(id)
  if (node === undefined) return undefined
  if (mode === 'new-folder') {
    return isFilingFolder(store, id) ? { mode, title: '', parent: id, folders: [] } : undefined
  }
  if (mode === 'rename-folder') {
    return node.kind === 'folder' && !['bar', 'other', 'reading'].includes(id) ? { mode, id, title: node.title, parent: node.parent, folders: [] } : undefined
  }
  if (node.kind !== 'url') return undefined
  return { mode, id, title: node.title, parent: node.parent, folders: folderChoices(store) }
}

/** "Tabs from 30 September 2026": the long date in the person's own locale. */
export function folderNameForToday (date: Date, locale?: string): string {
  return `Tabs from ${date.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' })}`
}

export interface TabToBookmark { url: string, title: string, favicon: string | null }

/** The tabs "Bookmark all tabs" saves, in strip order: every tab that is showing a site. The new-tab page and the shell's own pages have none. */
export function tabsToBookmark (tabs: readonly TabState[], faviconFor: (id: string) => string | null): TabToBookmark[] {
  return tabs
    .filter((tab) => !tab.isNewTab && !tab.isInternal && tab.url !== '')
    .map((tab) => ({ url: tab.url, title: tab.title.length > 0 ? tab.title : tab.url, favicon: faviconFor(tab.id) }))
}

export interface EditOutcome { ok: boolean, /** The id of a folder the command made. */ folder?: string }

/** Applies one command of the page-bookmark bubble to the store. `id` was checked against the bubble's own bookmark by the caller. */
export function applyEdit (store: EditStore, command: Extract<EditCommand, { type: 'save' | 'remove' }>): EditOutcome {
  if (command.type === 'remove') return { ok: store.remove([command.id]) > 0 }
  const node = store.node(command.id)
  if (node?.kind !== 'url' || !isFilingFolder(store, command.parent)) return { ok: false }
  let target = command.parent
  let made: string | undefined
  const folderName = command.newFolder?.trim()
  if (folderName !== undefined && folderName.length > 0) {
    const folder = store.addFolder({ title: folderName, parent: command.parent })
    if (folder === null) return { ok: false }
    target = folder.id
    made = folder.id
  }
  if (command.title !== node.title && !store.update(command.id, { title: command.title })) return { ok: false }
  if (target !== node.parent && !store.move([command.id], target)) return { ok: false }
  return made === undefined ? { ok: true } : { ok: true, folder: made }
}

/** "Rename…" (with an id) or "Add Folder…" (with the folder it goes in; the bar when none is given). */
export function applyFolderEdit (store: EditStore, command: Extract<EditCommand, { type: 'saveFolder' }>): EditOutcome {
  if (command.id !== undefined) {
    const node = store.node(command.id)
    if (node?.kind !== 'folder' || ['bar', 'other', 'reading'].includes(node.id)) return { ok: false }
    return { ok: command.title === node.title || store.update(command.id, { title: command.title }) }
  }
  const parent = command.parent ?? 'bar'
  if (!isFilingFolder(store, parent)) return { ok: false }
  const folder = store.addFolder({ title: command.title, parent })
  return folder === null ? { ok: false } : { ok: true, folder: folder.id }
}

/** One new folder holding a bookmark per tab, in one store change. Returns how many pages were saved. */
export function applySaveAll (store: EditStore, command: Extract<EditCommand, { type: 'saveAll' }>, tabs: readonly TabToBookmark[], fallbackName: string): number {
  if (!isFilingFolder(store, command.parent) || tabs.length === 0) return 0
  const title = command.title.trim().length > 0 ? command.title : fallbackName
  const saved = store.importTree(command.parent, [{ kind: 'folder', title, children: tabs.map((tab) => ({ kind: 'url', title: tab.title, url: tab.url })) }])
  if (saved > 0) for (const tab of tabs) if (tab.favicon !== null) store.fillMissingFavicon(tab.url, tab.favicon)
  return saved
}
