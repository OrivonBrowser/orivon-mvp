// What a directory's listing is made of: its entries, each typed by reading
// the entry's own node where that is affordable. A directory block names its
// children and their link sizes but not whether a child is a file or a
// folder, so a dag-pb child costs one verified block read to tell.

import { exporter } from 'ipfs-unixfs-exporter'
import type { UnixFSDirectory, UnixFSDirectoryEntry } from 'ipfs-unixfs-exporter'
import type { DirectoryListing, ListedEntry } from './directory-page.js'

const RAW = 0x55
const DAG_PB = 0x70

/** Rows shown; a bigger directory is cut here and says how many are left. */
export const LISTING_ROWS = 1000
/** Entries whose own node is read to type them; the rest show as file or folder. */
export const TYPED_ENTRIES = 100
/** Entries typed at the same time. */
const TYPING_CONCURRENCY = 6
/** How long typing may take in all before the page is sent with what it has. */
export const TYPING_BUDGET_MS = 20_000

type Store = Parameters<typeof exporter>[1]

/** Typed from the entry's own node, or undefined when that node could not be read in time. */
async function typed (entry: UnixFSDirectoryEntry, store: Store, signal: AbortSignal): Promise<ListedEntry | undefined> {
  try {
    const node = await exporter(entry.cid.toString(), store, { signal })
    if (node.type === 'directory') return { name: entry.name, kind: 'folder', size: 0n, exact: true }
    if (node.type === 'file' || node.type === 'raw' || node.type === 'identity') return { name: entry.name, kind: 'file', size: BigInt(node.size), exact: true }
  } catch {
    // An entry that cannot be read, or read verified, is listed as the directory names it; nothing of it is shown unverified.
  }
  return undefined
}

function untyped (entry: UnixFSDirectoryEntry): ListedEntry {
  const raw = entry.cid.code === RAW
  return { name: entry.name, kind: raw ? 'file' : 'unknown', size: entry.size, exact: false }
}

/** Runs `work` over `items` with at most `limit` at once. */
async function inParallel<T, R> (items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return results
}

/**
 * Throws what the walk throws (a ResolutionError) when the directory itself cannot be read.
 * `typingStore` reads under a deadline of its own, so a slow or missing entry never holds the page back.
 */
export async function listDirectory (dir: UnixFSDirectory, segments: readonly string[], typingStore: Store, typingSignal: AbortSignal): Promise<DirectoryListing> {
  const found: UnixFSDirectoryEntry[] = []
  for await (const entry of dir.entries({ length: LISTING_ROWS + 1 })) found.push(entry)
  const truncated = found.length > LISTING_ROWS
  const shown = found.slice(0, LISTING_ROWS)
  const sharded = dir.unixfs.type === 'hamt-sharded-directory'
  // Typing can ask for as many as TYPED_ENTRIES blocks; those entries are typed first-come, in the directory's own order.
  const toType = shown.filter((e) => e.cid.code === DAG_PB).slice(0, TYPED_ENTRIES)
  const results = new Map<UnixFSDirectoryEntry, ListedEntry | undefined>()
  await inParallel(toType, TYPING_CONCURRENCY, async (entry) => { results.set(entry, await typed(entry, typingStore, typingSignal)) })
  const entries = shown.map((e) => results.get(e) ?? untyped(e))
  return {
    segments,
    entries,
    truncated,
    more: truncated && !sharded ? dir.node.Links.length - LISTING_ROWS : undefined
  }
}
