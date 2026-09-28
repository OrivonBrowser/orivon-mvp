// A UnixFS file's bytes, walked from its root node over the verifying
// blockstore. The exporter resolves paths; its own file reader is not used,
// because a block failing two levels down escapes it as an unhandled
// rejection, which never reaches the caller.

import * as dagPb from '@ipld/dag-pb'
import type { PBNode } from '@ipld/dag-pb'
import { UnixFS } from 'ipfs-unixfs'
import type { CID } from 'multiformats/cid'
import { ResolutionError } from '../resolution/records.js'
import { RAW } from './verify-block.js'

/** Blocks fetched ahead of the one being yielded. */
const LOOKAHEAD = 8

export interface FileReadLimits {
  readonly maxDagDepth: number
}

function malformed (detail: string): ResolutionError {
  return new ResolutionError('unverifiable', `malformed UnixFS file: ${detail}`)
}

function overlap (bytes: Uint8Array, at: number, start: number, end: number): Uint8Array | undefined {
  const from = Math.max(start - at, 0)
  const to = Math.min(end - at + 1, bytes.length)
  return from < to ? bytes.subarray(from, to) : undefined
}

/** Starts a fetch whose failure is always observed, so it can only surface where it is awaited. */
function prefetch (get: (cid: CID) => Promise<Uint8Array>, cid: CID): Promise<Uint8Array> {
  const pending = get(cid)
  pending.catch(() => {})
  return pending
}

/**
 * The bytes of `[start, end]` (inclusive) of the file rooted at `node`, in
 * order. Each child is checked against the size its parent declared before
 * any of it is yielded, so a DAG whose sizes lie cannot shift or pad the
 * bytes served. Only the look-ahead window of blocks is held at once.
 */
export async function * readFileRange (node: PBNode, get: (cid: CID) => Promise<Uint8Array>, start: number, end: number, limits: FileReadLimits, depth = 0, at = 0, declared?: number): AsyncGenerator<Uint8Array> {
  if (depth > limits.maxDagDepth) throw new ResolutionError('unverifiable', `file DAG deeper than ${String(limits.maxDagDepth)} levels`)
  if (node.Data === undefined) throw malformed('a node with no UnixFS data')
  const unixfs = UnixFS.unmarshal(node.Data)
  // A symlink is published content this build does not follow, not a sign of tampering.
  if (unixfs.type === 'symlink' && depth === 0) throw new ResolutionError('unsupported', 'a UnixFS symlink, which this version of Orivon does not follow')
  if (unixfs.type !== 'file' && unixfs.type !== 'raw') throw malformed(`a ${unixfs.type} node inside a file`)
  if (node.Links.length !== unixfs.blockSizes.length) throw malformed('links and block sizes disagree')
  const own = unixfs.data ?? new Uint8Array()
  const total = unixfs.blockSizes.reduce((sum, size) => sum + Number(size), own.length)
  if (declared !== undefined && total !== declared) throw malformed(`a subtree of ${String(total)} bytes where ${String(declared)} were declared`)
  const inline = overlap(own, at, start, end)
  if (inline !== undefined) yield inline

  let position = at + own.length
  const children: Array<{ cid: CID, at: number, size: number }> = []
  node.Links.forEach((link, i) => {
    const size = Number(unixfs.blockSizes[i])
    if (position <= end && position + size - 1 >= start) children.push({ cid: link.Hash, at: position, size })
    position += size
  })

  const inFlight: Array<Promise<Uint8Array> | undefined> = children.slice(0, LOOKAHEAD).map((child) => prefetch(get, child.cid))
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!
    const bytes = await inFlight[i]!
    inFlight[i] = undefined
    const next = children[i + LOOKAHEAD]
    if (next !== undefined) inFlight.push(prefetch(get, next.cid))
    if (child.cid.code === RAW) {
      if (bytes.length !== child.size) throw malformed(`a leaf of ${String(bytes.length)} bytes where ${String(child.size)} were declared`)
      const slice = overlap(bytes, child.at, start, end)
      if (slice !== undefined) yield slice
      continue
    }
    const childNode = dagPb.decode(bytes)
    let produced = 0
    for await (const chunk of readFileRange(childNode, get, Math.max(start, child.at), Math.min(end, child.at + child.size - 1), limits, depth + 1, child.at, child.size)) {
      produced += chunk.length
      yield chunk
    }
    const expected = Math.min(end, child.at + child.size - 1) - Math.max(start, child.at) + 1
    if (produced !== expected) throw malformed(`a subtree yielding ${String(produced)} bytes where ${String(expected)} were declared`)
  }
}
