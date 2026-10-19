// A path under a verified root, read through the exporter over the verifying
// blockstore. `/` and a directory serve its `index.html`; a directory without
// one is answered with a listing of its entries (directory-page.ts), typed as
// HTML and served at the slash form of its path. A root that is itself one
// file is served at `/`, typed as HTML when its first bytes say so.

import { exporter } from 'ipfs-unixfs-exporter'
import type { UnixFSDirectory, UnixFSEntry } from 'ipfs-unixfs-exporter'
import type { CID } from 'multiformats/cid'
import { ResolutionError } from '../resolution/records.js'
import { pathSegments } from '../resolution/path-segments.js'
import type { GatherRange, GatheredFile, Refusal } from '../resolution/providers.js'
import { blockstoreFor } from './blockstore.js'
import type { BlockSource } from './blockstore.js'
import { LISTING_BUDGET_MS, listDirectory } from './directory-entries.js'
import { renderDirectoryPage } from './directory-page.js'
import { readFileRange } from './file-reader.js'
import { SNIFF_BYTES, looksLikeHtml } from './sniff.js'

const INDEX = 'index.html'

function failureOf (error: unknown, path: string): ResolutionError {
  if (error instanceof ResolutionError) return error
  const code = (error as { code?: unknown }).code
  if (code === 'ERR_NOT_FOUND' || code === 'ERR_BAD_PATH' || code === 'ERR_NO_PROP') return new ResolutionError('not-found', `${path} is not in this site`)
  return new ResolutionError('unsupported', `${path}: ${error instanceof Error ? error.message : String(error)}`)
}

async function entryAt (root: CID, segments: readonly string[], store: ReturnType<typeof blockstoreFor>, signal: AbortSignal): Promise<UnixFSEntry> {
  return await exporter([root.toString(), ...segments].join('/'), store, { signal })
}

async function readPrefix (chunks: AsyncIterable<Uint8Array>, path: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  try {
    for await (const chunk of chunks) parts.push(chunk)
  } catch (error) {
    throw failureOf(error, path)
  }
  return Buffer.concat(parts)
}

function listingOf (page: Uint8Array, segments: readonly string[]): GatheredFile {
  return {
    servedPath: `/${segments.map((s) => `${s}/`).join('')}`,
    size: page.length,
    contentType: 'text/html; charset=utf-8',
    listing: true,
    body: (async function * () { yield page })()
  }
}

/** Throws a ResolutionError. Every byte of the returned body was verified before it is yielded. */
export async function openPath (source: BlockSource, root: CID, pathname: string, range: GatherRange | undefined, signal: AbortSignal, onRefusal: (refusal: Refusal) => void): Promise<GatheredFile> {
  const segments = pathSegments(pathname)
  if (segments === undefined) throw new ResolutionError('not-found', `${pathname} is not a path this site can hold`)
  const budget = { blocks: 0, bytes: 0 }
  const store = blockstoreFor(source, budget, signal, onRefusal)
  let entry: UnixFSEntry
  let served = segments
  try {
    entry = await entryAt(root, segments, store, signal)
    if (entry.type === 'directory') {
      served = [...segments, INDEX]
      try {
        entry = await entryAt(root, served, store, signal)
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'ERR_NOT_FOUND') throw error
        // The slash form is the folder's address; the form without it only redirects, before any listing work.
        if (!pathname.endsWith('/')) return listingOf(new Uint8Array(0), segments)
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(source.limits.listingBudgetMs ?? LISTING_BUDGET_MS)])
        const listing = await listDirectory(async (walk) => await entryAt(root, segments, walk, deadline) as UnixFSDirectory, segments, blockstoreFor(source, budget, deadline, onRefusal), deadline, signal)
        return listingOf(renderDirectoryPage(listing), segments)
      }
    }
  } catch (error) {
    throw failureOf(error, pathname)
  }
  if (entry.type !== 'file' && entry.type !== 'raw' && entry.type !== 'identity') throw new ResolutionError('not-found', `${pathname} is not a file`)
  const size = Number(entry.size)
  const start = range?.start ?? 0
  const end = range?.end ?? size - 1
  const node = entry.node
  // blockstoreFor yields each verified block whole, as one chunk.
  const get = async (cid: CID): Promise<Uint8Array> => {
    for await (const block of store.get(cid)) return block
    throw new ResolutionError('unavailable', `block ${cid.toString()} came back empty`)
  }
  const content = entry.type === 'file'
    ? readFileRange(node as Parameters<typeof readFileRange>[0], get, start, end, source.limits)
    : (async function * () { if (size > 0) yield (node as Uint8Array).subarray(start, end + 1) })()
  let contentType: string | undefined
  if (served.length === 0 && size > 0) {
    const prefix = entry.type === 'file'
      ? await readPrefix(readFileRange(node as Parameters<typeof readFileRange>[0], get, 0, Math.min(SNIFF_BYTES, size) - 1, source.limits), pathname)
      : (node as Uint8Array).subarray(0, SNIFF_BYTES)
    if (looksLikeHtml(prefix)) contentType = 'text/html; charset=utf-8'
  }
  return {
    servedPath: `/${served.join('/')}`,
    size,
    ...(contentType !== undefined && { contentType }),
    body: (async function * () {
      try {
        for await (const chunk of content) yield chunk
      } catch (error) {
        throw failureOf(error, pathname)
      }
    })()
  }
}
