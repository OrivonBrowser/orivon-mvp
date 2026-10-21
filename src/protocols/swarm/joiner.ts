// A file from its root reference. Every chunk comes back from the chunk
// source already checked against its address, and each child is checked
// against the size its parent declared, so the root address commits to every
// byte yielded and a tree whose sizes lie cannot shift or pad the bytes.

import { bytesToHex } from 'viem'
import { ResolutionError } from '../resolution/records.js'
import type { GatherRange } from '../resolution/providers.js'
import { CHUNK_PAYLOAD_BYTES, REFERENCE_BYTES, SPAN_BYTES, isZeroPadding, readSpan } from './chunk.js'

/** Children fetched ahead of the one being read, in each intermediate chunk. */
const WINDOW = 16

export type GetChunk = (address: string) => Promise<Uint8Array>

export interface JoinLimits {
  readonly maxBytes: number
  readonly maxTreeDepth: number
}

export interface JoinedFile {
  readonly size: number
  /** The bytes of the inclusive range, in order; the whole file when none is given. */
  read: (range?: GatherRange) => AsyncGenerator<Uint8Array>
}

function malformed (detail: string): ResolutionError {
  return new ResolutionError('unverifiable', `malformed Swarm file: ${detail}`)
}

/** Starts a fetch whose failure is always observed, so it can only surface where it is awaited. */
function prefetch (get: GetChunk, address: string): Promise<Uint8Array> {
  const pending = get(address)
  pending.catch(() => {})
  return pending
}

function slice (bytes: Uint8Array, at: number, start: number, end: number): Uint8Array | undefined {
  const from = Math.max(start - at, 0)
  const to = Math.min(end - at + 1, bytes.length)
  return from < to ? bytes.subarray(from, to) : undefined
}

interface Child {
  readonly address: string
  readonly at: number
  readonly size: number
  /** Already fetched: child 0, which sets the size of the others. */
  readonly chunk: Promise<Uint8Array> | undefined
}

/**
 * Splits an intermediate chunk into the children covering [start, end]. The
 * data references are the leading ones whose spans add up to the parent's:
 * child 0 sets the size every child but the last has, the last has the rest,
 * and any reference past those is erasure-coding parity, never fetched.
 */
async function childrenOf (chunk: Uint8Array, size: number, level: number, at: number, start: number, end: number, get: GetChunk): Promise<Child[]> {
  const payload = chunk.subarray(SPAN_BYTES)
  if (payload.length === 0 || payload.length % REFERENCE_BYTES !== 0) throw malformed('an intermediate chunk that is not a list of references')
  const refs = payload.length / REFERENCE_BYTES
  const address = (i: number): string => bytesToHex(payload.subarray(i * REFERENCE_BYTES, (i + 1) * REFERENCE_BYTES)).slice(2)
  const first = await get(address(0))
  const unit = readSpan(first).size
  if (unit === 0) throw malformed('a child with no content under a parent that has some')
  const data = Math.ceil(size / unit)
  // BMT pads a payload with zeros, so zero bytes after the last reference are the same chunk.
  const lastNeeded = payload.subarray((data - 1) * REFERENCE_BYTES, data * REFERENCE_BYTES)
  const padded = level === 0 && data < refs && !isZeroPadding(lastNeeded) && isZeroPadding(payload.subarray(data * REFERENCE_BYTES))
  if (data > refs || (level === 0 && data !== refs && !padded)) throw malformed(`${String(refs)} references for ${String(data)} children`)
  const children: Child[] = []
  for (let i = 0; i < data; i++) {
    const childAt = at + i * unit
    const childSize = i < data - 1 ? unit : size - (data - 1) * unit
    if (childAt > end || childAt + childSize - 1 < start) continue
    children.push({ address: address(i), at: childAt, size: childSize, chunk: i === 0 ? Promise.resolve(first) : undefined })
  }
  return children
}

async function * readChunk (chunk: Uint8Array, expected: number, at: number, start: number, end: number, depth: number, get: GetChunk, limits: JoinLimits): AsyncGenerator<Uint8Array> {
  const { size, level } = readSpan(chunk)
  if (size !== expected) throw malformed(`a subtree of ${String(size)} bytes where ${String(expected)} were declared`)
  const payload = chunk.subarray(SPAN_BYTES)
  if (size <= CHUNK_PAYLOAD_BYTES) {
    // BMT pads a payload with zeros, so zero bytes past the span are the same chunk; only `size` are content.
    if (payload.length < size || !isZeroPadding(payload.subarray(size))) throw malformed(`a leaf of ${String(payload.length)} bytes where ${String(size)} were declared`)
    const part = slice(payload.subarray(0, size), at, start, end)
    if (part !== undefined) yield part
    return
  }
  if (depth >= limits.maxTreeDepth) throw malformed(`a tree deeper than ${String(limits.maxTreeDepth)} levels`)
  const children = await childrenOf(chunk, size, level, at, start, end, get)
  const pending: Array<Promise<Uint8Array> | undefined> = children.slice(0, WINDOW).map((child) => child.chunk ?? prefetch(get, child.address))
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!
    const bytes = await pending[i]!
    pending[i] = undefined
    const ahead = children[i + WINDOW]
    if (ahead !== undefined) pending.push(prefetch(get, ahead.address))
    let produced = 0
    for await (const part of readChunk(bytes, child.size, child.at, Math.max(start, child.at), Math.min(end, child.at + child.size - 1), depth + 1, get, limits)) {
      produced += part.length
      yield part
    }
    const wanted = Math.min(end, child.at + child.size - 1) - Math.max(start, child.at) + 1
    if (produced !== wanted) throw malformed(`a subtree yielding ${String(produced)} bytes where ${String(wanted)} were declared`)
  }
}

/** Fetches the root chunk, which says how large the file is, and returns a reader over it. Throws a ResolutionError. */
export async function openFile (get: GetChunk, reference: string, limits: JoinLimits): Promise<JoinedFile> {
  const root = await get(reference)
  const { size } = readSpan(root)
  if (size > limits.maxBytes) throw new ResolutionError('unverifiable', `a file of ${String(size)} bytes, over the ${String(limits.maxBytes)} a request may read`)
  return {
    size,
    read: (range) => {
      const start = range?.start ?? 0
      const end = Math.min(range?.end ?? size - 1, size - 1)
      if (size > 0 && start > end) return (async function * () {})()
      return readChunk(root, size, 0, start, end, 0, get, limits)
    }
  }
}

/** The whole file, or a ResolutionError once it is known to be over `max` bytes. */
export async function readWhole (file: JoinedFile, max: number): Promise<Uint8Array> {
  if (file.size > max) throw new ResolutionError('unverifiable', `a file of ${String(file.size)} bytes where at most ${String(max)} are read`)
  const out = new Uint8Array(file.size)
  let at = 0
  for await (const part of file.read()) {
    out.set(part, at)
    at += part.length
  }
  return out
}
