// A path under a verified root, read through the exporter over the verifying
// blockstore. `/` and a directory serve its `index.html`; there are no
// directory listings.

import { exporter } from 'ipfs-unixfs-exporter'
import type { UnixFSEntry } from 'ipfs-unixfs-exporter'
import type { CID } from 'multiformats/cid'
import { ResolutionError } from '../resolution/records.js'
import type { GatherRange, GatheredFile, Refusal } from '../resolution/providers.js'
import { blockstoreFor } from './blockstore.js'
import type { BlockSource } from './blockstore.js'
import { readFileRange } from './file-reader.js'

const INDEX = 'index.html'

/**
 * A URL pathname's segments, percent-decoded. Undefined for anything that
 * could name something other than a child of the root: `.`, `..`, an
 * encoded slash, a NUL, or an empty segment before the end.
 */
export function pathSegments (pathname: string): string[] | undefined {
  if (!pathname.startsWith('/')) return undefined
  const raw = pathname.slice(1).split('/')
  if (raw[raw.length - 1] === '') raw.pop()
  const segments: string[] = []
  for (const part of raw) {
    let segment: string
    try {
      segment = decodeURIComponent(part)
    } catch {
      return undefined
    }
    if (segment === '' || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\0')) return undefined
    segments.push(segment)
  }
  return segments
}

function failureOf (error: unknown, path: string): ResolutionError {
  if (error instanceof ResolutionError) return error
  const code = (error as { code?: unknown }).code
  if (code === 'ERR_NOT_FOUND' || code === 'ERR_BAD_PATH' || code === 'ERR_NO_PROP') return new ResolutionError('not-found', `${path} is not in this site`)
  return new ResolutionError('unsupported', `${path}: ${error instanceof Error ? error.message : String(error)}`)
}

async function entryAt (root: CID, segments: readonly string[], store: ReturnType<typeof blockstoreFor>, signal: AbortSignal): Promise<UnixFSEntry> {
  return await exporter([root.toString(), ...segments].join('/'), store, { signal })
}

/** Throws a ResolutionError. Every byte of the returned body was verified before it is yielded. */
export async function openPath (source: BlockSource, root: CID, pathname: string, range: GatherRange | undefined, signal: AbortSignal, onRefusal: (refusal: Refusal) => void): Promise<GatheredFile> {
  const segments = pathSegments(pathname)
  if (segments === undefined) throw new ResolutionError('not-found', `${pathname} is not a path this site can hold`)
  const store = blockstoreFor(source, { blocks: 0, bytes: 0 }, signal, onRefusal)
  let entry: UnixFSEntry
  let served = segments
  try {
    entry = await entryAt(root, segments, store, signal)
    if (entry.type === 'directory') {
      served = [...segments, INDEX]
      entry = await entryAt(root, served, store, signal)
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
  return {
    servedPath: `/${served.join('/')}`,
    size,
    body: (async function * () {
      try {
        for await (const chunk of content) yield chunk
      } catch (error) {
        throw failureOf(error, pathname)
      }
    })()
  }
}
