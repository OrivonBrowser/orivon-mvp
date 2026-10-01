// What the manager is showing and has chosen: one object, read by the modules that draw it and the ones that react
// to keys, so nothing is held in two places. The shapes of the replies are the bookmarks domain's.
import { internalBridge } from '../shared/bridge.js'
import type { FolderInfo } from './folder-tree.js'

export interface Row {
  readonly id: string
  readonly kind: 'url' | 'folder'
  readonly title: string
  readonly url?: string
  /** The row's icon as a data URL, resolved from the reply's table. */
  readonly icon: string | null
  /** A folder's child count, and how many of them are pages. */
  readonly items?: number
  readonly pages?: number
  /** A search result: the folder it is in, and the titles on the way to it. */
  readonly parent?: string
  readonly path?: readonly string[]
}

export interface Crumb {
  readonly id: string
  readonly title: string
}

/** What is being edited in place; `fresh`: the folder was just made, so nothing is lost by leaving it as it is. */
export interface Editing {
  readonly id: string
  readonly fresh: boolean
}

export interface ManagerState {
  loaded: boolean
  isPrivate: boolean
  importAvailable: boolean
  folders: FolderInfo[]
  /** Folders of the tree that are open, by id. */
  expanded: Set<string>
  current: string
  crumbs: Crumb[]
  rows: Row[]
  /** The search text, and its results (null while there is none). */
  query: string
  results: Row[] | null
  moreResults: boolean
  selected: Set<string>
  anchor: string | null
  focusId: string | null
  treeFocus: string | null
  editing: Editing | null
  /** How many rows of a long folder are drawn; the rest arrive as the list is scrolled. */
  shown: number
}

export const CHUNK = 300

export const state: ManagerState = {
  loaded: false, isPrivate: false, importAvailable: false, folders: [], expanded: new Set(['bar', 'other']), current: 'bar', crumbs: [],
  rows: [], query: '', results: null, moreResults: false, selected: new Set(), anchor: null, focusId: null, treeFocus: null, editing: null, shown: CHUNK
}

const bridge = internalBridge()

export const platform = bridge.platform
export const onEvent = bridge.onEvent

export async function request<T = unknown> (command: object): Promise<T | undefined> {
  return await bridge.request('bookmarks', command) as T | undefined
}

/** What the list shows: the search results while there is a search, else the folder's children. */
export const listed = (): Row[] => state.results ?? state.rows
export const listedIds = (): string[] => listed().map((row) => row.id)
export const rowById = (id: string | null): Row | undefined => id === null ? undefined : listed().find((row) => row.id === id)

/** Rows of a reply, with each icon index resolved. */
export function rowsFrom (rows: ReadonlyArray<Record<string, unknown>>, icons: readonly string[]): Row[] {
  return rows.map((row) => {
    const index = typeof row['icon'] === 'number' ? row['icon'] : -1
    return { ...row, icon: icons[index] ?? null } as unknown as Row
  })
}
