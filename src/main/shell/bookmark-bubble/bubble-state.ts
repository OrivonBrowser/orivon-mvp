// What the bubble remembers between one opening and the next: which folder a new bookmark goes to, and which
// bookmark was made a moment ago so its bubble can say "added". Both live in memory and are checked when read.
import type { BookmarkStore } from '../../browsing/bookmarks.js'
import type { ShellWindow } from '../window-registry.js'
import { isFilingFolder } from './edit-model.js'

export const EDIT_OVERLAY = 'bookmark-edit'
export const ALL_TABS_OVERLAY = 'bookmark-all-tabs'

/** How long after a bookmark was made its bubble still says "added": the chrome's round trip, not a memory. */
const ADDED_WINDOW_MS = 5000

const lastFolders = new WeakMap<object, string>()
const justAdded = new WeakMap<ShellWindow, { id: string, at: number }>()

/** The folder the last bookmark was filed in, or the bar when there is none or it has been deleted since. */
export function lastFolderOf (store: Pick<BookmarkStore, 'node' | 'path'>): string {
  const id = lastFolders.get(store)
  return id !== undefined && isFilingFolder(store, id) ? id : 'bar'
}

export function rememberFolder (store: object, id: string): void {
  lastFolders.set(store, id)
}

export function markAdded (window: ShellWindow, id: string, now: number = Date.now()): void {
  justAdded.set(window, { id, at: now })
}

/** Whether `id` was made in this window moments ago; asking uses the mark up. */
export function takeAdded (window: ShellWindow, id: string, now: number = Date.now()): boolean {
  const mark = justAdded.get(window)
  justAdded.delete(window)
  return mark !== undefined && mark.id === id && now - mark.at < ADDED_WINDOW_MS
}
