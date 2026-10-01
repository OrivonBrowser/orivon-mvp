// The bookmark store: the tree in memory, its file on disk, and the one API every surface reads and writes
// it through. Main holds the truth; the chrome and the pages receive what they show and send ids back.
// The file is plain JSON under <userData>, not a secret (ADR-0003's fifth storage tier).
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomicAsync } from '../../broker/adapters/atomic-write.js'
import { exportNodes, importNodes } from './bookmark-import.js'
import { parseBookmarksFile, sanitizeStoredFavicon, serializeBookmarksFile } from './bookmark-file.js'
import type { FileState } from './bookmark-file.js'
import {
  addNode, BOOKMARK_ROOTS, childrenOf, emptyTree, fillFavicon, flattenUrls, folderList, moveNodes, nodeCount, pathTo,
  randomId, removeNodes, searchUrls, updateNode
} from './bookmark-tree.js'
import type { BookmarkTree, IdSource, NodePatch } from './bookmark-tree.js'
import type { BookmarkNode, BookmarkTreeInput } from './bookmark-types.js'
import { sanitizeDirectUrl } from './omnibox.js'
import { DebouncedWriter } from '../storage/debounced-writer.js'

export { WRITE_DEBOUNCE_MS } from '../storage/debounced-writer.js'
export { MAX_STORED_FAVICON_CHARS, sanitizeStoredFavicon } from './bookmark-file.js'

/** A page as the new-tab dashboard and the flat consumers see it. */
export interface Bookmark {
  url: string
  title: string
  /** The site's own icon as a `data:` URL, captured from the tab when it was starred: the bar renders at once and
   * offline, and a privileged view never makes a request for an icon. `null` until one arrives. */
  favicon: string | null
}

/** What a caller hands `BookmarkStore.add`. */
export interface BookmarkInput {
  url: string
  title: string
  favicon?: string | null
}

export interface AddUrlInput extends BookmarkInput {
  /** A folder or root id; the bar by default. */
  parent?: string
  index?: number
}

export class BookmarkStore {
  private tree: BookmarkTree = emptyTree()
  private loading: Promise<void> | null = null
  private readonly listeners = new Set<() => void>()
  private readonly writer = new DebouncedWriter(async () => { await this.writeNow() })
  /** What the file was when read: a legacy or unreadable file is kept aside before the first write replaces it. */
  private fileState: FileState = 'current'
  /** A notice of a late icon is queued and has not run yet. */
  private iconNoticePending = false
  private kept = false
  /** The addresses of the bar and Other bookmarks, rebuilt when the tree changes: `has` runs on every state push. */
  private addresses: ReadonlySet<string> | null = null

  constructor (private readonly filePath: string, private readonly newId: IdSource = randomId, private readonly clock: () => number = Date.now) {}

  /** Reads the file once, however many windows ask: a second read would replace the tree with what is on disk and
   * drop any change not yet flushed. A missing, unreadable or corrupt file yields an empty tree rather than an
   * error: a browser that refuses to start over its bookmarks is the worse failure. A legacy file is converted and
   * rewritten in format 2, so ids are stable from then on; an unknown version is left alone until the person
   * changes something. */
  load (): Promise<void> {
    this.loading ??= this.readFromDisk()
    return this.loading
  }

  private async readFromDisk (): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      // No file is a first launch. A file that is there and cannot be read is not: it is kept as it is until the next
      // write has made a copy of it.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.fileState = 'unreadable'
      return
    }
    const modified = await stat(this.filePath).then((info) => info.mtimeMs, () => this.clock())
    const parsed = parseBookmarksFile(raw, { legacyAdded: Math.trunc(modified), newId: this.newId })
    this.tree = parsed.tree
    this.addresses = null
    this.fileState = parsed.state
    if (parsed.state === 'legacy') this.writer.schedule()
  }

  // Reads

  node (id: string): BookmarkNode | undefined { return this.tree.nodes.get(id) }
  children (parent: string): BookmarkNode[] { return childrenOf(this.tree, parent) }
  /** The nodes from the root down to `id`, both included. */
  path (id: string): BookmarkNode[] { return pathTo(this.tree, id) }
  /** The folders of the bar and of Other bookmarks, depth first, each root at depth 0: what a folder picker lists. */
  folders (): Array<{ node: BookmarkNode, depth: number }> { return folderList(this.tree) }
  /** Every page of that address in the bar and Other bookmarks. */
  findByUrl (url: string): BookmarkNode[] { return flattenUrls(this.tree, BOOKMARK_ROOTS).filter((node) => node.url === url) }
  has (url: string): boolean {
    this.addresses ??= new Set(flattenUrls(this.tree, BOOKMARK_ROOTS).map((node) => node.url ?? ''))
    return this.addresses.has(url)
  }
  search (text: string, limit: number): BookmarkNode[] { return searchUrls(this.tree, text, limit) }
  /** Nodes below the roots, folders included: the unit the 20,000 cap counts. */
  count (): number { return nodeCount(this.tree) }
  exportTree (): Record<'bar' | 'other', BookmarkTreeInput[]> { return exportNodes(this.tree) }

  /** Every page of the bar, then Other bookmarks, depth first, as the flat consumers want them. */
  getAll (): Bookmark[] {
    return flattenUrls(this.tree, BOOKMARK_ROOTS).map(({ url, title, favicon }) => ({ url: url ?? '', title, favicon: favicon ?? null }))
  }

  // Writes

  addUrl (input: AddUrlInput): BookmarkNode | null {
    const url = sanitizeDirectUrl(input.url)
    if (url === null) return null
    const added = addNode(this.tree, { kind: 'url', title: input.title, url, favicon: sanitizeStoredFavicon(input.favicon), added: this.clock() }, input.parent ?? 'bar', input.index, this.newId)
    if (added === null) return null
    this.commit(added.tree)
    return added.node
  }

  addFolder (input: { title: string, parent: string, index?: number }): BookmarkNode | null {
    const added = addNode(this.tree, { kind: 'folder', title: input.title, added: this.clock() }, input.parent, input.index, this.newId)
    if (added === null) return null
    this.commit(added.tree)
    return added.node
  }

  update (id: string, patch: NodePatch): boolean {
    const next = updateNode(this.tree, id, patch)
    if (next === null) return false
    this.commit(next)
    return true
  }

  /** `index` is a position in `parent`'s list as it stands now. */
  move (ids: readonly string[], parent: string, index?: number): boolean {
    const next = moveNodes(this.tree, ids, parent, index)
    if (next === null) return false
    this.commit(next)
    return true
  }

  /** By id, with a folder's subtree; or by address: every page of that URL. Returns how many ids went. */
  remove (target: string | readonly string[]): number {
    const ids = typeof target === 'string' ? this.findByUrl(target).map((node) => node.id) : target
    const { tree, removed } = removeNodes(this.tree, ids)
    if (removed > 0) this.commit(tree)
    return removed
  }

  /** One write and one change event for the whole tree. Returns the pages added. */
  importTree (parent: string, tree: readonly BookmarkTreeInput[], index?: number): number {
    const result = importNodes(this.tree, parent, tree, index, this.newId, this.clock())
    if (result === null) return 0
    if (result.nodes > 0) this.commit(result.tree)
    return result.added
  }

  /** Adds a page to the end of the bar; one already at the top of the bar keeps its place and takes the new title. */
  add (entry: BookmarkInput): void {
    const url = sanitizeDirectUrl(entry.url)
    if (url === null) return
    const existing = childrenOf(this.tree, 'bar').find((node) => node.url === url)
    if (existing === undefined) {
      this.addUrl({ ...entry, url })
      return
    }
    const icon = sanitizeStoredFavicon(entry.favicon)
    const renamed = updateNode(this.tree, existing.id, { title: entry.title })
    if (renamed === null) return
    this.commit((icon === null ? null : fillFavicon(renamed, url, icon)) ?? renamed)
  }

  /** Fills the icon of every saved page of that address that has none, and reports whether anything changed.
   * The listeners hear of it one microtask later, never inside the call: its caller runs inside a state push, and a
   * notification there would push state from within a push. Every window then draws the icon, not only the one whose
   * push found it. An icon already stored is never replaced: it is the one the person chose when starring. */
  fillMissingFavicon (url: string, favicon: string): boolean {
    const safe = sanitizeStoredFavicon(favicon)
    if (safe === null) return false
    const next = fillFavicon(this.tree, url, safe)
    if (next === null) return false
    this.tree = next
    this.writer.schedule()
    if (!this.iconNoticePending) {
      this.iconNoticePending = true
      queueMicrotask(() => {
        this.iconNoticePending = false
        for (const listener of [...this.listeners]) listener()
      })
    }
    return true
  }

  /** Returns the removal: a window that closes must stop listening. */
  onChange (cb: () => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  /** Resolves once the file reflects every change made up to this call, and rejects with the write's error if that
   * write failed: the quit-time flush and the tests wait on the real write, not a guessed delay. */
  async flushPendingWrite (): Promise<void> {
    await this.writer.flush()
  }

  private commit (next: BookmarkTree): void {
    this.tree = next
    this.addresses = null
    for (const listener of this.listeners) listener()
    this.writer.schedule()
  }

  private async writeNow (): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      if (!this.kept && this.fileState !== 'current') {
        // The old file is the only copy of what this build could not read or has just converted.
        await copyFile(this.filePath, `${this.filePath}.bak`).catch((error: NodeJS.ErrnoException) => {
          // An unreadable file is replaced only once its copy exists; without one, the write waits.
          if (this.fileState === 'unreadable' && error.code !== 'ENOENT') throw error
        })
        this.kept = true
      }
      await writeFileAtomicAsync(this.filePath, serializeBookmarksFile(this.tree))
    } catch (error) {
      // Loud, never silent: losing a write is recoverable, hiding it is not. Re-thrown so flush() rejects.
      console.error('[orivon] failed to persist bookmarks:', error)
      throw error
    }
  }
}
