// chrome.bookmarks over the shell's bookmark store. The tree is shaped by bookmarks-shape.ts, the events
// are derived from the store's changes by bookmarks-diff.ts, and every write counts against Chrome's quota
// (bookmarks-quota.ts). The reading list is a root of the same store and is never visible here. A bookmark
// an extension writes is an ordinary one: the bar, the star and the manager see it through the store's
// own change event.
import { MAX_NODES } from '../../browsing/bookmark-tree.js'
import { sanitizeDirectUrl } from '../../browsing/omnibox.js'
import type { ShellServices } from '../../shell/shell-services.js'
import { diffSnapshots, takeSnapshot } from './bookmarks-diff.js'
import type { BookmarkChange, Snapshot } from './bookmarks-diff.js'
import { createWriteQuota } from './bookmarks-quota.js'
import type { WriteQuota } from './bookmarks-quota.js'
import {
  chromeRoot, CHROME_ROOT_ID, isChromeRoot, matchesWords, OTHER_ID, queryWords, toChromeNode, toStoreId
} from './bookmarks-shape.js'
import type { ChromeBookmarkNode, NodeLike } from './bookmarks-shape.js'
import type { ApiEvent, ExtensionApiContext, ExtensionApiModule } from './api-types.js'

export const NOT_FOUND = "Can't find bookmark for id."
export const ROOT_ERROR = "Can't modify the root bookmark folders."
export const BAD_URL = 'Invalid URL.'
export const LIMIT_ERROR = 'Bookmark limit reached.'
const MAX_IDS = 1000
const RECENT_MAX = 100

/** What this module uses of `BookmarkStore`. */
export type BookmarkStoreLike = Pick<ShellServices['bookmarks'],
'load' | 'node' | 'children' | 'path' | 'onChange' | 'addUrl' | 'addFolder' | 'update' | 'move' | 'remove' | 'count'>

function fail (message: string): never { throw new Error(message) }

function storeOf (ctx: ExtensionApiContext): BookmarkStoreLike {
  return ctx.shell()?.bookmarks ?? fail('Bookmarks are not available yet.')
}

function idOf (value: unknown): string {
  if (typeof value !== 'string' || value === '') return fail('Invalid argument: a bookmark id is a non-empty string.')
  return value
}

function objectOf (value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail(`Invalid argument: ${what} must be an object.`)
  return value as Record<string, unknown>
}

function indexOf (value: unknown, limit: number): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > limit) return fail('Index out of bounds.')
  return value
}

function textOf (value: unknown, what: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return typeof value === 'string' ? value : fail(`Invalid argument: ${what} must be a string.`)
}

function positionOf (store: BookmarkStoreLike, node: NodeLike): number {
  return store.children(node.parent).findIndex((child) => child.id === node.id)
}

/** The node at `id`'s Chrome shape, with everything below it when `deep`. */
function shape (store: BookmarkStoreLike, node: NodeLike, deep: boolean, index = positionOf(store, node)): ChromeBookmarkNode {
  const children = node.kind === 'folder' && deep
    ? store.children(node.id).map((child, at) => shape(store, child, true, at))
    : undefined
  return toChromeNode(node, index, children)
}

/** A node of the reading list, at any depth: it is not part of this API, whatever id an extension names. */
function inReadingList (store: BookmarkStoreLike, node: NodeLike): boolean {
  return node.id === 'reading' || store.path(node.id)[0]?.id === 'reading'
}

/** The node an extension named, or undefined for one that is not there or not for an extension to see. */
function visibleNode (store: BookmarkStoreLike, storeId: string | undefined): NodeLike | undefined {
  const node = storeId === undefined ? undefined : store.node(storeId)
  return node === undefined || inReadingList(store, node) ? undefined : node
}

function lookup (store: BookmarkStoreLike, chromeId: string): NodeLike {
  return visibleNode(store, toStoreId(chromeId)) ?? fail(NOT_FOUND)
}

function rootChildren (store: BookmarkStoreLike, deep: boolean): ChromeBookmarkNode[] {
  return ['bar', 'other'].flatMap((root, at) => { const node = store.node(root); return node === undefined ? [] : [shape(store, node, deep, at)] })
}

function everyNode (store: BookmarkStoreLike): Array<{ node: NodeLike, index: number }> {
  const out: Array<{ node: NodeLike, index: number }> = []
  const walk = (parent: string): void => {
    store.children(parent).forEach((node, index) => {
      out.push({ node, index })
      if (node.kind === 'folder') walk(node.id)
    })
  }
  walk('bar')
  walk('other')
  return out
}

function search (store: BookmarkStoreLike, query: unknown): ChromeBookmarkNode[] {
  let words: string[]
  let url: string | undefined
  let title: string | undefined
  if (typeof query === 'string') {
    words = queryWords(query)
  } else {
    const given = objectOf(query, 'the query')
    words = queryWords(textOf(given.query, 'query') ?? '')
    const wanted = textOf(given.url, 'url')
    url = wanted === undefined ? undefined : (sanitizeDirectUrl(wanted) ?? wanted)
    title = textOf(given.title, 'title')
  }
  return everyNode(store)
    .filter(({ node }) => matchesWords(node, words) && (url === undefined || node.url === url) && (title === undefined || node.title === title))
    .map(({ node, index }) => shape(store, node, false, index))
}

function recent (store: BookmarkStoreLike, count: unknown): ChromeBookmarkNode[] {
  if (typeof count !== 'number' || !Number.isInteger(count)) return fail('Invalid argument: the number of items must be an integer.')
  const wanted = Math.min(Math.max(count, 1), RECENT_MAX)
  return everyNode(store)
    .filter(({ node }) => node.kind === 'url')
    .sort((a, b) => b.node.added - a.node.added)
    .slice(0, wanted)
    .map(({ node, index }) => shape(store, node, false, index))
}

function create (store: BookmarkStoreLike, details: unknown): ChromeBookmarkNode {
  const given = objectOf(details, 'the bookmark')
  const parentChrome = textOf(given.parentId, 'parentId') ?? OTHER_ID
  if (parentChrome === CHROME_ROOT_ID) fail(ROOT_ERROR)
  const parentId = toStoreId(parentChrome)
  const parent = visibleNode(store, parentId)
  if (parent === undefined) fail("Can't find parent bookmark for id.")
  if (parent?.kind !== 'folder') fail('Parent node is not a folder.')
  const index = indexOf(given.index, store.children(parentId as string).length)
  const title = textOf(given.title, 'title') ?? ''
  const address = textOf(given.url, 'url')
  const target = { title, parent: parentId as string, ...(index === undefined ? {} : { index }) }
  let created: NodeLike | null
  if (address === undefined) {
    created = store.addFolder(target)
  } else {
    const safe = sanitizeDirectUrl(address)
    if (safe === null) fail(BAD_URL)
    created = store.addUrl({ ...target, url: safe as string })
  }
  if (created === null) return fail(store.count() >= MAX_NODES ? LIMIT_ERROR : "Can't create a bookmark here.")
  return shape(store, created, false)
}

function update (store: BookmarkStoreLike, chromeId: string, changes: unknown): ChromeBookmarkNode {
  if (isChromeRoot(chromeId)) fail(ROOT_ERROR)
  const node = lookup(store, chromeId)
  const given = objectOf(changes, 'the changes')
  const title = textOf(given.title, 'title')
  const address = textOf(given.url, 'url')
  let url: string | undefined
  if (address !== undefined) {
    if (node.kind === 'folder') fail("Can't set a URL on a folder.")
    url = sanitizeDirectUrl(address) ?? fail(BAD_URL)
  }
  const patch = { ...(title === undefined ? {} : { title }), ...(url === undefined ? {} : { url }) }
  if (!store.update(node.id, patch)) fail("Can't update the bookmark.")
  return shape(store, store.node(node.id) as NodeLike, false)
}

function move (store: BookmarkStoreLike, chromeId: string, destination: unknown): ChromeBookmarkNode {
  if (isChromeRoot(chromeId)) fail(ROOT_ERROR)
  const node = lookup(store, chromeId)
  const given = objectOf(destination, 'the destination')
  const parentChrome = textOf(given.parentId, 'parentId')
  if (parentChrome === CHROME_ROOT_ID) fail(ROOT_ERROR)
  const parent = parentChrome === undefined ? visibleNode(store, node.parent) : visibleNode(store, toStoreId(parentChrome))
  if (parent === undefined) fail("Can't find parent bookmark for id.")
  if (parent?.kind !== 'folder') fail('Parent node is not a folder.')
  const target = parent as NodeLike
  if (store.path(target.id).some((above) => above.id === node.id)) fail("Can't move a folder into itself or one of its descendants.")
  const index = indexOf(given.index, store.children(target.id).length)
  if (!store.move([node.id], target.id, index)) fail("Can't move the bookmark there.")
  return shape(store, store.node(node.id) as NodeLike, false)
}

function remove (store: BookmarkStoreLike, chromeId: string, recursive: boolean): void {
  if (isChromeRoot(chromeId)) fail(ROOT_ERROR)
  const node = lookup(store, chromeId)
  if (!recursive && node.kind === 'folder' && store.children(node.id).length > 0) {
    fail("Can't remove non-empty folder (use recursive to force).")
  }
  store.remove([node.id])
}

function emit (ctx: ExtensionApiContext, change: BookmarkChange): void {
  switch (change.type) {
    case 'created': ctx.sendEvent(undefined, 'bookmarks.onCreated', change.id, change.node); return
    case 'removed': ctx.sendEvent(undefined, 'bookmarks.onRemoved', change.id, change.info); return
    case 'changed': ctx.sendEvent(undefined, 'bookmarks.onChanged', change.id, change.info); return
    case 'moved': ctx.sendEvent(undefined, 'bookmarks.onMoved', change.id, change.info)
  }
}

/** Keeps a snapshot of the tree, while an extension that may read it is loaded, and turns each store change into the events Chrome sends. */
function watch (ctx: ExtensionApiContext, store: BookmarkStoreLike): void {
  let snapshot: Snapshot | undefined
  let queued = false
  let started = false
  const take = (): Snapshot => takeSnapshot((parent) => store.children(parent))
  const anyHolds = (): boolean => ctx.session.extensions.getAllExtensions().some((extension) => ctx.held(extension.id, 'bookmarks'))
  // With no such extension a store change costs nothing: no snapshot is kept or walked.
  const sync = (): void => {
    if (!started) return
    if (anyHolds()) snapshot ??= take()
    else snapshot = undefined
  }
  const settle = (): void => {
    queued = false
    if (!anyHolds()) { snapshot = undefined; return }
    const next = take()
    const before = snapshot
    snapshot = next
    if (before === undefined) return
    try {
      for (const change of diffSnapshots(before, next)) emit(ctx, change)
    } catch (error) {
      console.error('[orivon] a bookmarks event could not be sent:', error)
    }
  }
  ctx.session.extensions.on('extension-loaded', sync)
  ctx.session.extensions.on('extension-unloaded', sync)
  // The file is read once, so the first snapshot is the tree as loaded and not an empty one.
  void store.load().then(() => {
    started = true
    sync()
    store.onChange(() => {
      if (queued) return
      queued = true
      queueMicrotask(settle)
    })
  })
}

export function installBookmarks (ctx: ExtensionApiContext, quota: WriteQuota = createWriteQuota()): void {
  const read = <T>(name: string, run: (store: BookmarkStoreLike, ...args: unknown[]) => T): void => {
    ctx.handle(`bookmarks.${name}`, async (_event, ...args) => {
      const store = storeOf(ctx)
      await store.load()
      return run(store, ...args)
    })
  }
  const write = <T>(name: string, run: (store: BookmarkStoreLike, ...args: unknown[]) => T): void => {
    ctx.handle(`bookmarks.${name}`, async (event: ApiEvent, ...args) => {
      const store = storeOf(ctx)
      await store.load()
      quota.take(event.extension.id)
      return run(store, ...args)
    })
  }

  read('get', (store, ids) => {
    const list = Array.isArray(ids) ? ids : [ids]
    if (list.length === 0 || list.length > MAX_IDS) return fail('Invalid argument: pass one id or up to 1000 ids.')
    return list.map((raw) => {
      const id = idOf(raw)
      return id === CHROME_ROOT_ID ? chromeRoot() : shape(store, lookup(store, id), false)
    })
  })
  read('getChildren', (store, id) => {
    const chromeId = idOf(id)
    if (chromeId === CHROME_ROOT_ID) return rootChildren(store, false)
    const node = lookup(store, chromeId)
    return node.kind === 'folder' ? store.children(node.id).map((child, at) => shape(store, child, false, at)) : []
  })
  read('getRecent', recent)
  read('getTree', (store) => [chromeRoot(rootChildren(store, true))])
  read('getSubTree', (store, id) => {
    const chromeId = idOf(id)
    return [chromeId === CHROME_ROOT_ID ? chromeRoot(rootChildren(store, true)) : shape(store, lookup(store, chromeId), true)]
  })
  read('search', search)
  write('create', create)
  write('update', (store, id, changes) => update(store, idOf(id), changes))
  write('move', (store, id, destination) => move(store, idOf(id), destination))
  write('remove', (store, id) => { remove(store, idOf(id), false) })
  write('removeTree', (store, id) => { remove(store, idOf(id), true) })

  ctx.onShell((shell) => { watch(ctx, shell.bookmarks) })
}

export const bookmarksApi: ExtensionApiModule = {
  name: 'bookmarks',
  permission: 'bookmarks',
  install: (ctx) => { installBookmarks(ctx) }
}

