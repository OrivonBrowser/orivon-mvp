// A file from its root reference. Every chunk comes back from the chunk
// source already checked against its address, and each child is checked
// against the size its parent declared, so the root address commits to every
// byte yielded and a tree whose sizes lie cannot shift or pad the bytes.

import { bytesToHex } from 'viem'
import { ResolutionError } from '../resolution/records.js'
import type { GatherRange } from '../resolution/providers.js'
import { CHUNK_PAYLOAD_BYTES, REFERENCE_BYTES, SPAN_BYTES, isZeroPadding, readSpan } from './chunk.js'
import type { SubtreeLeaf } from './chunk-fetch.js'

/** Intermediate chunks fetched ahead of the one being walked, among the children of one intermediate chunk. */
const WINDOW = 16
/** Leaves fetched ahead of the one being read, across the whole file: each 4 KB leaf is a round trip to the node. */
export const AHEAD = 64

export type GetChunk = (address: string) => Promise<Uint8Array>
/** The leaves under the intermediate chunk at `parent`, in order, each a chunk already checked against its address. */
export type GetLeaves = (parent: string, leaves: readonly SubtreeLeaf[]) => Array<Promise<Uint8Array>>

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

/** `chunk`, whose first child is asked for as soon as it arrives: the walk waits on that child to size the others. */
function withFirstChild (chunk: Promise<Uint8Array>, get: GetChunk): Promise<Uint8Array> {
  chunk.then((bytes) => {
    if (bytes.length >= SPAN_BYTES + REFERENCE_BYTES) void prefetch(get, bytesToHex(bytes.subarray(SPAN_BYTES, SPAN_BYTES + REFERENCE_BYTES)).slice(2))
  }, () => {})
  return chunk
}

/** A leaf the read wants: where it sits, the size its parent declares for it, and the part of it inside the range. */
interface Leaf {
  readonly address: string
  readonly at: number
  readonly size: number
  readonly start: number
  readonly end: number
  readonly chunk: Promise<Uint8Array> | undefined
}

function malformedSize (size: number, expected: number): ResolutionError {
  return malformed(`a subtree of ${String(size)} bytes where ${String(expected)} were declared`)
}

/** The part of a leaf inside the range, once its span is the size its parent declared. */
function leafBytes (chunk: Uint8Array, leaf: Leaf): Uint8Array | undefined {
  const { size } = readSpan(chunk)
  if (size !== leaf.size) throw malformedSize(size, leaf.size)
  const payload = chunk.subarray(SPAN_BYTES)
  // BMT pads a payload with zeros, so zero bytes past the span are the same chunk; only `size` are content.
  if (payload.length < size || !isZeroPadding(payload.subarray(size))) throw malformed(`a leaf of ${String(payload.length)} bytes where ${String(size)} were declared`)
  return slice(payload.subarray(0, size), leaf.at, leaf.start, leaf.end)
}

/**
 * The leaves under `chunk`, at `address`, that cover [start, end], in order. Intermediate chunks are fetched here,
 * WINDOW ahead among siblings, and checked against the size their parent declared; the leaves of one intermediate
 * chunk are asked for together when `getLeaves` is given, and otherwise each is fetched by the reader. Every leaf is
 * checked against its declared size by the reader.
 */
async function * leavesOf (address: string, chunk: Uint8Array, expected: number, at: number, start: number, end: number, depth: number, get: GetChunk, getLeaves: GetLeaves | undefined, limits: JoinLimits): AsyncGenerator<Leaf> {
  const { size, level } = readSpan(chunk)
  if (size !== expected) throw malformedSize(size, expected)
  if (size <= CHUNK_PAYLOAD_BYTES) {
    yield { address: '', at, size, start, end, chunk: Promise.resolve(chunk) }
    return
  }
  if (depth >= limits.maxTreeDepth) throw malformed(`a tree deeper than ${String(limits.maxTreeDepth)} levels`)
  const children = await childrenOf(chunk, size, level, at, start, end, get)
  if (getLeaves !== undefined && children.length > 1 && children.every((child) => child.size <= CHUNK_PAYLOAD_BYTES)) {
    const fetched = getLeaves(address, children.map((child) => ({ address: child.address, size: child.size, offset: child.at - at })))
    for (const [i, child] of children.entries()) {
      const leaf = fetched[i]!
      leaf.catch(() => {})
      yield { address: child.address, at: child.at, size: child.size, start: Math.max(start, child.at), end: Math.min(end, child.at + child.size - 1), chunk: child.chunk ?? leaf }
    }
    return
  }
  const inner: Array<Promise<Uint8Array> | undefined> = []
  const request = (upTo: number): void => {
    for (let i = inner.length; i < Math.min(upTo, children.length); i++) {
      const child = children[i]!
      inner.push(child.size > CHUNK_PAYLOAD_BYTES ? child.chunk ?? withFirstChild(prefetch(get, child.address), get) : undefined)
    }
  }
  request(WINDOW)
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!
    const childStart = Math.max(start, child.at)
    const childEnd = Math.min(end, child.at + child.size - 1)
    if (child.size <= CHUNK_PAYLOAD_BYTES) {
      yield { address: child.address, at: child.at, size: child.size, start: childStart, end: childEnd, chunk: child.chunk }
      continue
    }
    request(i + 1 + WINDOW)
    const bytes = await inner[i]!
    inner[i] = undefined
    yield * leavesOf(child.address, bytes, child.size, child.at, childStart, childEnd, depth + 1, get, getLeaves, limits)
  }
}

/**
 * The bytes of [start, end], in order, with up to AHEAD leaves in flight across the whole file: the walk runs ahead of
 * the bytes being yielded, so the end of one intermediate chunk's children does not empty the pipeline. Whatever fails,
 * a fetch or a check, surfaces only once every byte before it has been yielded.
 */
async function * readTree (reference: string, root: Uint8Array, size: number, start: number, end: number, get: GetChunk, getLeaves: GetLeaves | undefined, limits: JoinLimits): AsyncGenerator<Uint8Array> {
  const walk = leavesOf(reference, root, size, 0, start, end, 0, get, getLeaves, limits)
  const queue: Array<{ readonly leaf: Leaf, readonly chunk: Promise<Uint8Array> }> = []
  let walking = false
  let walked = false
  let failure: { readonly error: unknown } | undefined
  let wake: (() => void) | undefined
  const step = (): void => {
    if (walking || walked || queue.length >= AHEAD) return
    walking = true
    walk.next().then((result) => {
      if (result.done === true) walked = true
      else queue.push({ leaf: result.value, chunk: result.value.chunk ?? prefetch(get, result.value.address) })
    }, (error: unknown) => {
      walked = true
      failure = { error }
    }).finally(() => {
      walking = false
      wake?.()
      step()
    })
  }
  let produced = 0
  try {
    for (;;) {
      step()
      const next = queue.shift()
      if (next === undefined) {
        if (walked) break
        await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
        continue
      }
      step()
      const part = leafBytes(await next.chunk, next.leaf)
      if (part === undefined) continue
      produced += part.length
      yield part
    }
  } finally {
    walked = true
    void walk.return(undefined).catch(() => {})
  }
  if (failure !== undefined) throw failure.error
  if (produced !== end - start + 1) throw malformed(`a file yielding ${String(produced)} bytes where ${String(end - start + 1)} were declared`)
}

/** Fetches the root chunk, which says how large the file is, and returns a reader over it. Throws a ResolutionError. */
export async function openFile (get: GetChunk, reference: string, limits: JoinLimits, getLeaves?: GetLeaves): Promise<JoinedFile> {
  const root = await get(reference)
  const { size } = readSpan(root)
  if (size > limits.maxBytes) throw new ResolutionError('unverifiable', `a file of ${String(size)} bytes, over the ${String(limits.maxBytes)} a request may read`)
  return {
    size,
    read: (range) => {
      const start = range?.start ?? 0
      const end = Math.min(range?.end ?? size - 1, size - 1)
      if (size > 0 && start > end) return (async function * () {})()
      return readTree(reference, root, size, start, end, get, getLeaves, limits)
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
