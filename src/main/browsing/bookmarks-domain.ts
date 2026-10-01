// What the bookmark manager page may ask of the bookmarks: read a folder or a search, edit, move, delete and take the
// delete back, open, copy, and save the file. The requests are data from a document, so every field is checked here.
// A page names nodes by id; the addresses it opens and copies are read from the store.
import { randomBytes } from 'node:crypto'
import type { BaseWindow, WebContents } from 'electron'
import type { InternalDomain } from '../pages/internal-ipc.js'
import type { ShellWindow } from '../shell/window-registry.js'
import type { BookmarkNode, BookmarkTreeInput } from './bookmark-types.js'
import { ID_PATTERN, MAX_NODES } from './bookmark-tree.js'
import type { BookmarkStore } from './bookmarks.js'
import { MAX_UNDO_NODES, UNDO_MS, restore, snapshot, topLevel } from './bookmarks-undo.js'
import type { RemovedBatch } from './bookmarks-undo.js'

export type ManagerDisposition = 'current' | 'tab' | 'background' | 'window' | 'private'
const DISPOSITIONS: readonly ManagerDisposition[] = ['current', 'tab', 'background', 'window', 'private']

/** As many as a folder can hold: a page lets the person choose every row of one, and a request that names them all is not refused. */
export const MAX_IDS = MAX_NODES
export const MAX_SEARCH_RESULTS = 200
const MAX_SEARCH_TEXT = 200
const MAX_TITLE_TEXT = 4_096
const MAX_URL_TEXT = 16_384
/** The longest id `ID_PATTERN` takes: a longer text is a malformed request, not a node that is missing. */
const MAX_ID_LENGTH = 32

type Store = Pick<BookmarkStore, 'node' | 'children' | 'path' | 'folders' | 'search' | 'addFolder' | 'update' | 'move' | 'remove' | 'importTree' | 'exportTree'>

export interface BookmarksDomainDeps {
  readonly isPrivate: boolean
  readonly windowOf: (contents: WebContents) => ShellWindow | undefined
  readonly open: (window: ShellWindow, id: string, disposition: ManagerDisposition) => boolean
  readonly openAll: (window: ShellWindow, id: string) => number
  readonly copyText: (text: string) => void
  /** Whether the import page exists in this build. */
  readonly importAvailable: () => boolean
  readonly runImport: (window: ShellWindow) => void
  readonly exportFile: (window: BaseWindow | undefined, tree: Record<'bar' | 'other', BookmarkTreeInput[]>) => Promise<'saved' | 'cancelled' | 'write'>
  readonly now?: () => number
}

interface Request {
  readonly type?: unknown
  readonly id?: unknown
  readonly ids?: unknown
  readonly parent?: unknown
  readonly index?: unknown
  readonly title?: unknown
  readonly url?: unknown
  readonly text?: unknown
  readonly token?: unknown
  readonly disposition?: unknown
}

/** A row as the page draws it; an icon is an index into the reply's `icons`, so a folder of one site sends it once. */
function rowOf (store: Store, node: BookmarkNode, icons: string[]): Record<string, unknown> {
  let icon: number | null = null
  if (typeof node.favicon === 'string' && node.favicon !== '') {
    icon = icons.indexOf(node.favicon)
    if (icon === -1) icon = icons.push(node.favicon) - 1
  }
  return {
    id: node.id, kind: node.kind, title: node.title, added: node.added, icon,
    ...(node.url === undefined ? {} : { url: node.url }),
    ...(node.kind === 'folder' ? { items: store.children(node.id).length, pages: store.children(node.id).filter((child) => child.kind === 'url').length } : {})
  }
}

function countPages (items: readonly BookmarkTreeInput[]): number {
  return items.reduce((sum, item) => sum + (item.kind === 'folder' ? countPages(item.children ?? []) : 1), 0)
}

export function bookmarksDomain (store: Store, deps: BookmarksDomainDeps): InternalDomain {
  const now = deps.now ?? Date.now
  let removed: RemovedBatch | null = null

  /** A node of the bar or Other bookmarks, or of a folder in them: the reading list is not this page's. */
  const inScope = (id: unknown): id is string => {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) return false
    const root = store.path(id)[0]
    return root !== undefined && (root.id === 'bar' || root.id === 'other')
  }
  const idList = (value: unknown): string[] | null =>
    Array.isArray(value) && value.length > 0 && value.length <= MAX_IDS && value.every(inScope) ? value as string[] : null
  const indexOf = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined

  return {
    pages: ['bookmarks'],
    handle: async (command, caller) => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as Request
      switch (request.type) {
        case 'tree':
          return {
            private: deps.isPrivate,
            importAvailable: deps.importAvailable(),
            folders: store.folders().map(({ node, depth }) => ({
              id: node.id, title: node.title, depth,
              folders: store.children(node.id).filter((child) => child.kind === 'folder').length,
              items: store.children(node.id).length
            }))
          }
        case 'children': {
          if (!inScope(request.id)) return undefined
          const icons: string[] = []
          return {
            id: request.id,
            path: store.path(request.id).map((node) => ({ id: node.id, title: node.title })),
            rows: store.children(request.id).map((node) => rowOf(store, node, icons)),
            icons
          }
        }
        case 'search': {
          if (typeof request.text !== 'string') return undefined
          const found = store.search(request.text.slice(0, MAX_SEARCH_TEXT), MAX_SEARCH_RESULTS + 1)
          const icons: string[] = []
          return {
            rows: found.slice(0, MAX_SEARCH_RESULTS).map((node) => ({
              ...rowOf(store, node, icons), parent: node.parent, path: store.path(node.id).slice(0, -1).map((above) => above.title)
            })),
            more: found.length > MAX_SEARCH_RESULTS,
            icons
          }
        }
        case 'addFolder': {
          if (!inScope(request.parent) || typeof request.title !== 'string' || request.title.length > MAX_TITLE_TEXT) return undefined
          const index = indexOf(request.index)
          const made = store.addFolder({ title: request.title, parent: request.parent, ...(index === undefined ? {} : { index }) })
          return made === null ? { ok: false, reason: 'limit' } : { ok: true, id: made.id }
        }
        case 'update': {
          if (typeof request.id !== 'string' || request.id.length > MAX_ID_LENGTH) return undefined
          if (request.title !== undefined && (typeof request.title !== 'string' || request.title.length > MAX_TITLE_TEXT)) return undefined
          if (request.url !== undefined && (typeof request.url !== 'string' || request.url.length > MAX_URL_TEXT)) return undefined
          if (request.title === undefined && request.url === undefined) return undefined
          if (!inScope(request.id)) return { ok: false, reason: 'missing' }
          const done = store.update(request.id, { ...(request.title === undefined ? {} : { title: request.title }), ...(request.url === undefined ? {} : { url: request.url }) })
          return done ? { ok: true } : { ok: false, reason: 'url' }
        }
        case 'move': {
          const ids = idList(request.ids)
          if (ids === null || !inScope(request.parent)) return undefined
          const index = indexOf(request.index)
          return { ok: store.move(ids, request.parent, index) }
        }
        case 'remove': {
          const ids = idList(request.ids)
          if (ids === null) return undefined
          const top = topLevel(store, ids).filter((id) => store.node(id)?.parent !== '')
          const kept = snapshot(store, top)
          const count = store.remove(top)
          if (count === 0) return { removed: 0, items: 0, undo: null }
          removed = kept.nodes <= MAX_UNDO_NODES ? { token: randomBytes(8).toString('hex'), at: now(), items: kept.items } : null
          return { removed: count, items: kept.nodes, undo: removed?.token ?? null }
        }
        case 'undo': {
          const batch = removed
          if (typeof request.token !== 'string' || batch === null || batch.token !== request.token) return { ok: false, reason: 'expired' }
          removed = null
          if (now() - batch.at > UNDO_MS) return { ok: false, reason: 'expired' }
          return { ok: true, ids: restore(store, batch.items) }
        }
        case 'open': {
          const disposition = DISPOSITIONS.find((candidate) => candidate === request.disposition)
          const window = deps.windowOf(caller.contents)
          if (!inScope(request.id) || disposition === undefined) return undefined
          return { ok: window !== undefined && deps.open(window, request.id, disposition) }
        }
        case 'openAll': {
          const window = deps.windowOf(caller.contents)
          if (!inScope(request.id)) return undefined
          return { ok: window !== undefined, opened: window === undefined ? 0 : deps.openAll(window, request.id) }
        }
        case 'copy': {
          const ids = idList(request.ids)
          if (ids === null) return undefined
          const urls = ids.flatMap((id) => store.node(id)?.url ?? [])
          if (urls.length > 0) deps.copyText(urls.join('\n'))
          return { ok: true, count: urls.length }
        }
        case 'import': {
          const window = deps.windowOf(caller.contents)
          if (window === undefined || !deps.importAvailable()) return { ok: false }
          deps.runImport(window)
          return { ok: true }
        }
        case 'export': {
          const tree = store.exportTree()
          const outcome = await deps.exportFile(deps.windowOf(caller.contents)?.window, tree)
          return outcome === 'saved' ? { ok: true, count: countPages(tree.bar) + countPages(tree.other) } : { ok: false, reason: outcome }
        }
        default:
          return undefined
      }
    }
  }
}
