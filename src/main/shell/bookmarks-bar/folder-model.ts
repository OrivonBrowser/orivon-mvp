// What the folder menu lists for one folder, and the requests its page may make. Pure: the store is handed in.
import type { BookmarkStore } from '../../browsing/bookmarks.js'
import { isClickDisposition, OPEN_ALL_LIMIT } from './open-bookmark.js'
import type { ClickDisposition } from './open-bookmark.js'

/** A menu of thousands of rows is no menu: past this the rest is named, not listed. */
export const MAX_ROWS = 400

export interface FolderRow {
  id: string
  kind: 'url' | 'folder'
  title: string
  url?: string
  favicon?: string | null
}

export interface FolderModel {
  id: string
  title: string
  rows: FolderRow[]
  /** Children past MAX_ROWS that are not listed. */
  more: number
  /** Pages "Open all" would open, before the cap. */
  pages: number
  openAllLimit: number
  /** Set for the bar's overflow list: the index of its first item among the bar's children. Such a list has no "Open all". */
  from?: number
}

export type FolderRequest =
  | { type: 'children', id: string, from?: number }
  | { type: 'open', id: string, disposition: ClickDisposition }
  | { type: 'openAll', id: string }

/** The folder's listing, or null when `id` is not a folder of the bar or of Other bookmarks. */
export function folderModel (store: Pick<BookmarkStore, 'node' | 'children' | 'path'>, id: string, from?: number): FolderModel | null {
  const folder = store.node(id)
  if (folder?.kind !== 'folder') return null
  const root = store.path(id)[0]?.id
  if (root !== 'bar' && root !== 'other') return null
  const children = store.children(id).slice(from ?? 0)
  const rows = children.slice(0, MAX_ROWS).map((child): FolderRow => child.kind === 'folder'
    ? { id: child.id, kind: 'folder', title: child.title }
    : { id: child.id, kind: 'url', title: child.title, url: child.url ?? '', favicon: child.favicon ?? null })
  const model: FolderModel = { id, title: folder.title, rows, more: Math.max(children.length - MAX_ROWS, 0), pages: children.filter((child) => child.kind === 'url').length, openAllLimit: OPEN_ALL_LIMIT }
  if (from !== undefined) model.from = from
  return model
}

/** An index from a renderer: a whole number from zero, or nothing. */
export function asFrom (value: unknown): number | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

export function asFolderRequest (command: unknown): FolderRequest | undefined {
  if (typeof command !== 'object' || command === null) return undefined
  const { type, id, disposition } = command as Record<string, unknown>
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (type === 'children') {
    const from = asFrom((command as Record<string, unknown>)['from'])
    return from === null ? undefined : from === undefined ? { type, id } : { type, id, from }
  }
  if (type === 'openAll') return { type, id }
  if (type === 'open' && isClickDisposition(disposition)) return { type, id, disposition }
  return undefined
}
