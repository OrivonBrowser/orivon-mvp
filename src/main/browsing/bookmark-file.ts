// What bookmarks.json holds and how it is read. Pure: the store reads the file and hands the text here.
// `bookmarks.json` is a plain user-writable file, so anything in it is untrusted input to a privileged
// view: every address is checked again and every icon is decoded and re-encoded on the way in.
import { decodeDataUrl, MAX_FAVICON_BYTES, toDataUrl } from './favicon-format.js'
import { ID_PATTERN, MAX_DEPTH, MAX_NODES, ROOTS, clipTitle, emptyDraft, freshId, randomId } from './bookmark-tree.js'
import type { BookmarkTree, IdSource, TreeDraft } from './bookmark-tree.js'
import type { BookmarkNode, BookmarkRoot } from './bookmark-types.js'
import { sanitizeBrowserUrl } from './local-file-input.js'

export const FILE_VERSION = 2

/** A stored favicon is only ever a `data:` image, capped at the size favicon-fetch.ts enforces on the wire: base64's
 * 4/3 expansion plus slack for the media-type prefix. */
export const MAX_STORED_FAVICON_CHARS = Math.ceil(MAX_FAVICON_BYTES * 4 / 3) + 64

/** Runs on load as well as on write. The prefix and size checks alone would accept anything merely labelled
 * `image/*`, so the payload is decoded and sniffed too, and comes back re-encoded under the label its bytes carry. */
export function sanitizeStoredFavicon (value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (!value.startsWith('data:image/')) return null
  if (value.length > MAX_STORED_FAVICON_CHARS) return null
  const bytes = decodeDataUrl(value, MAX_FAVICON_BYTES)
  return bytes === null ? null : toDataUrl(bytes)
}

/** How the file was read, which decides what the first write must do. */
export type FileState =
  /** Format 2. */
  | 'current'
  /** A bare array of pages: to be rewritten in format 2, keeping the old file beside it. */
  | 'legacy'
  /** Not JSON, or a version this build does not know: loads empty, and the file is kept aside before it is replaced. */
  | 'unreadable'

export interface ParsedFile {
  tree: BookmarkTree
  state: FileState
}

export interface ParseOptions {
  /** Stands in for the missing date of a legacy entry. */
  legacyAdded?: number
  newId?: IdSource
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function readFavicon (entry: Record<string, unknown>): string | null {
  // A rejected icon drops the icon, never the bookmark: losing a saved page over its icon is the worse failure.
  return sanitizeStoredFavicon(entry['favicon'])
}

/** One node of the file, and what is under it, into `draft`; returns its id, or null when it is dropped. */
function readNode (raw: unknown, parent: string, depth: number, draft: TreeDraft, newId: IdSource): string | null {
  if (!isRecord(raw) || depth > MAX_DEPTH || draft.nodes.size - ROOTS.length >= MAX_NODES) return null
  const title = typeof raw['title'] === 'string' ? clipTitle(raw['title']) : null
  if (title === null) return null
  const added = typeof raw['added'] === 'number' && Number.isFinite(raw['added']) ? raw['added'] : 0
  const given = raw['id']
  // A missing, reused, root-named or oddly shaped id gets a new one: ids are stable from the first load on, and the
  // manager page can only name a node whose id looks like one.
  const id = typeof given === 'string' && ID_PATTERN.test(given) && !draft.nodes.has(given) ? given : freshId(draft.nodes, newId)
  if (raw['kind'] === 'url') {
    const url = typeof raw['url'] === 'string' ? sanitizeBrowserUrl(raw['url']) : null
    if (url === null) return null
    const node: BookmarkNode = { id, parent, kind: 'url', title, url, favicon: readFavicon(raw), added }
    if (typeof raw['read'] === 'boolean') node.read = raw['read']
    draft.nodes.set(id, node)
    return id
  }
  if (raw['kind'] !== 'folder') return null
  draft.nodes.set(id, { id, parent, kind: 'folder', title, added })
  draft.kids.set(id, readList(raw['children'], id, depth + 1, draft, newId))
  return id
}

function readList (raw: unknown, parent: string, depth: number, draft: TreeDraft, newId: IdSource): string[] {
  if (!Array.isArray(raw)) return []
  const ids: string[] = []
  for (const item of raw) {
    // The reading list is flat: a folder in it is dropped.
    if (parent === 'reading' && isRecord(item) && item['kind'] === 'folder') continue
    const id = readNode(item, parent, depth, draft, newId)
    if (id !== null) ids.push(id)
  }
  return ids
}

function readLegacy (list: readonly unknown[], added: number, newId: IdSource): TreeDraft {
  const draft = emptyDraft()
  const ids: string[] = []
  for (const entry of list) {
    if (!isRecord(entry)) continue
    const { url, title } = entry
    if (typeof url !== 'string' || typeof title !== 'string') continue
    const safe = sanitizeBrowserUrl(url)
    if (safe === null) continue
    const id = freshId(draft.nodes, newId)
    draft.nodes.set(id, { id, parent: 'bar', kind: 'url', title: clipTitle(title), url: safe, favicon: readFavicon(entry), added })
    ids.push(id)
  }
  draft.kids.set('bar', ids.slice(0, MAX_NODES))
  return draft
}

export function parseBookmarksFile (raw: string, { legacyAdded = 0, newId = randomId }: ParseOptions = {}): ParsedFile {
  let data: unknown
  try { data = JSON.parse(raw) } catch { return { tree: emptyDraft(), state: 'unreadable' } }
  if (Array.isArray(data)) return { tree: readLegacy(data, legacyAdded, newId), state: 'legacy' }
  if (!isRecord(data) || data['version'] !== FILE_VERSION || !isRecord(data['roots'])) return { tree: emptyDraft(), state: 'unreadable' }
  const draft = emptyDraft()
  for (const root of ROOTS) draft.kids.set(root, readList(data['roots'][root], root, 1, draft, newId))
  return { tree: draft, state: 'current' }
}

interface FileNode { id: string, kind: 'url' | 'folder', title: string, url?: string, favicon?: string, added: number, read?: boolean, children?: FileNode[] }

export function serializeBookmarksFile (tree: BookmarkTree): string {
  const write = (id: string): FileNode[] => (tree.kids.get(id) ?? []).flatMap((childId): FileNode[] => {
    const node = tree.nodes.get(childId)
    if (node === undefined) return []
    const out: FileNode = { id: node.id, kind: node.kind, title: node.title, added: node.added }
    if (node.kind === 'url') {
      if (node.url !== undefined) out.url = node.url
      if (node.favicon !== undefined && node.favicon !== null) out.favicon = node.favicon
      if (node.read !== undefined) out.read = node.read
    } else {
      out.children = write(node.id)
    }
    return [out]
  })
  const roots = Object.fromEntries(ROOTS.map((root: BookmarkRoot) => [root, write(root)]))
  return JSON.stringify({ version: FILE_VERSION, roots }, null, 2)
}
