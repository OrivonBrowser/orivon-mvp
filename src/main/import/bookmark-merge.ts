// Where imported bookmarks go, and how a second import of the same browser adds nothing twice. Pure over a
// small view of the store: it reads the folders and adds trees, and never names a node by anything but the
// id the store gave it.
import type { BookmarkNode, BookmarkTreeInput } from '../browsing/bookmark-types.js'
import { sanitizeDirectUrl } from '../browsing/omnibox.js'
import type { SourceBookmarks } from './import-types.js'

/** The part of the bookmark store an import uses. */
export interface BookmarkSink {
  children: (parent: string) => BookmarkNode[]
  /** Adds the tree under `parent`; answers the pages added. */
  importTree: (parent: string, tree: readonly BookmarkTreeInput[]) => number
}

export interface Placement {
  /** Pages in the source, before anything was left out. */
  readonly total: number
  readonly imported: number
  /** Pages already where they would have gone. */
  readonly known: number
  readonly target: 'bar' | 'folder'
  readonly folderTitle?: string
}

export function countPages (inputs: readonly BookmarkTreeInput[]): number {
  let pages = 0
  for (const item of inputs) pages += item.kind === 'url' ? 1 : countPages(item.children ?? [])
  return pages
}

/** The address as the store keeps it, so a page in the source is found when it is already there. */
const keyOf = (url: string | undefined): string => sanitizeDirectUrl(url ?? '') ?? (url ?? '')

/** The tree without the pages the store would refuse: they are counted as skipped, and must not make a folder for nothing. */
function withoutInvalid (inputs: readonly BookmarkTreeInput[]): BookmarkTreeInput[] {
  return inputs.flatMap((item): BookmarkTreeInput[] => {
    if (item.kind === 'url') return sanitizeDirectUrl(item.url ?? '') === null ? [] : [item]
    return [{ ...item, children: withoutInvalid(item.children ?? []) }]
  })
}

/** `inputs` without the pages that already sit directly in one of `parents`, and without the folders that hold nothing else but such pages. */
export function pruneKnown (view: Pick<BookmarkSink, 'children'>, parents: readonly string[], inputs: readonly BookmarkTreeInput[]): BookmarkTreeInput[] {
  const existing = parents.flatMap((parent) => view.children(parent))
  const addresses = new Set(existing.filter((node) => node.kind === 'url').map((node) => node.url ?? ''))
  const out: BookmarkTreeInput[] = []
  for (const item of inputs) {
    if (item.kind === 'url') {
      if (!addresses.has(keyOf(item.url))) out.push(item)
      continue
    }
    const same = existing.filter((node) => node.kind === 'folder' && node.title === item.title).map((node) => node.id)
    const children = same.length === 0 ? (item.children ?? []) : pruneKnown(view, same, item.children ?? [])
    if (same.length > 0 && children.length === 0) continue
    out.push({ ...item, children })
  }
  return out
}

/** Adds `inputs` under `parent`, going into a folder of the same name that is already there instead of making another. */
function mergeInto (store: BookmarkSink, parent: string, inputs: readonly BookmarkTreeInput[]): { added: number, known: number } {
  const existing = store.children(parent)
  const addresses = new Set(existing.filter((node) => node.kind === 'url').map((node) => node.url ?? ''))
  const fresh: BookmarkTreeInput[] = []
  let added = 0
  let known = 0
  for (const item of inputs) {
    if (item.kind === 'url') {
      if (addresses.has(keyOf(item.url))) known += 1
      else fresh.push(item)
      continue
    }
    const match = existing.find((node) => node.kind === 'folder' && node.title === item.title)
    if (match === undefined) {
      fresh.push(item)
      continue
    }
    const inside = mergeInto(store, match.id, item.children ?? [])
    added += inside.added
    known += inside.known
  }
  if (fresh.length > 0) added += store.importTree(parent, fresh)
  return { added, known }
}

/** Into the bar and Other bookmarks as the source had them when the person has no bookmarks yet; otherwise into one folder on the bar. */
export function placeBookmarks (store: BookmarkSink, source: SourceBookmarks, folderTitle: string): Placement {
  const total = countPages(source.bar) + countPages(source.other)
  const usable = { bar: withoutInvalid(source.bar), other: withoutInvalid(source.other) }
  if (store.children('bar').length === 0 && store.children('other').length === 0) {
    const imported = store.importTree('bar', usable.bar) + store.importTree('other', usable.other)
    return { total, imported, known: 0, target: 'bar' }
  }
  // Something imported by an earlier run may sit at the top of the bar or of Other bookmarks, where an empty store puts it.
  // Or in an earlier run's folder: flat when one side of the source was empty then, else in its two sub-folders.
  const earlier = store.children('bar').filter((node) => node.kind === 'folder' && node.title === folderTitle)
  const inEarlier = (side: string): string[] => earlier.flatMap((wrapper) => [wrapper.id, ...store.children(wrapper.id).filter((node) => node.kind === 'folder' && node.title === side).map((node) => node.id)])
  const bar = pruneKnown(store, inEarlier('Bookmarks bar'), pruneKnown(store, ['bar'], usable.bar))
  const other = pruneKnown(store, inEarlier('Other bookmarks'), pruneKnown(store, ['other'], usable.other))
  const contents: BookmarkTreeInput[] = bar.length > 0 && other.length > 0
    ? [{ kind: 'folder', title: 'Bookmarks bar', children: bar }, { kind: 'folder', title: 'Other bookmarks', children: other }]
    : [...bar, ...other]
  const { added, known } = contents.length === 0 ? { added: 0, known: 0 } : mergeInto(store, 'bar', [{ kind: 'folder', title: folderTitle, children: contents }])
  const usableTotal = countPages(usable.bar) + countPages(usable.other)
  return { total, imported: added, known: usableTotal - countPages(bar) - countPages(other) + known, target: 'folder', folderTitle }
}
