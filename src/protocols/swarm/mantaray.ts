// Mantaray 0.2, the manifest format of Swarm websites: a radix trie whose
// nodes are files. A node is a 32-byte obfuscation key and then, XORed with
// that key repeating, a version, the entry reference, a 256-bit fork bitmap
// and the forks. A fork names a child node by a prefix of at most 30 bytes.

import { bytesToHex, keccak256, toBytes } from 'viem'
import { ResolutionError } from '../resolution/records.js'
import { REFERENCE_BYTES } from './chunk.js'

const KEY_BYTES = 32
const VERSION_BYTES = 31
const BITMAP_BYTES = 32
const PREFIX_FIELD_BYTES = 30
const FORK_FIXED_BYTES = 2 + PREFIX_FIELD_BYTES + REFERENCE_BYTES
const MAX_METADATA_BYTES = 0xffff

const VERSION_02 = keccak256(toBytes('mantaray:0.2'), 'bytes').subarray(0, VERSION_BYTES)
const VERSION_01 = keccak256(toBytes('mantaray:0.1'), 'bytes').subarray(0, VERSION_BYTES)

const TYPE_METADATA = 16

export interface Fork {
  readonly prefix: Uint8Array
  /** The child node's file, lowercase hex. */
  readonly reference: string
  /** String metadata the fork carries: `Content-Type`, `website-index-document`, `swarm-feed-owner`. */
  readonly metadata: Readonly<Record<string, string>> | undefined
}

export interface ManifestNode {
  /** The file this node's path names, lowercase hex, or undefined when the entry is all zeros. */
  readonly entry: string | undefined
  /** Keyed by the first byte of the fork's prefix. */
  readonly forks: ReadonlyMap<number, Fork>
}

function malformed (detail: string): ResolutionError {
  return new ResolutionError('unverifiable', `malformed Mantaray node: ${detail}`)
}

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, i) => byte === b[i])

function readMetadata (bytes: Uint8Array): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\n+$/, ''))
  } catch {
    throw malformed('fork metadata that is not JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw malformed('fork metadata that is not an object')
  const metadata: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string') metadata[key] = value
  return metadata
}

/** Throws a ResolutionError: `unsupported` for another version or an encrypted node, `unverifiable` for a node that breaks its own format. */
export function decodeNode (raw: Uint8Array): ManifestNode {
  if (raw.length < KEY_BYTES + VERSION_BYTES + 1) throw malformed('shorter than its header')
  const key = raw.subarray(0, KEY_BYTES)
  const data = new Uint8Array(raw.length - KEY_BYTES)
  for (let i = 0; i < data.length; i++) data[i] = raw[KEY_BYTES + i]! ^ key[i % KEY_BYTES]!
  const version = data.subarray(0, VERSION_BYTES)
  if (!same(version, VERSION_02)) throw new ResolutionError('unsupported', same(version, VERSION_01) ? 'a Mantaray 0.1 manifest, which this version of Orivon does not read' : 'content that is not a Mantaray 0.2 manifest')
  const referenceBytes = data[VERSION_BYTES]!
  if (referenceBytes === 64) throw new ResolutionError('unsupported', 'an encrypted Swarm manifest, which this version of Orivon does not read')
  if (referenceBytes !== REFERENCE_BYTES) throw malformed(`references of ${String(referenceBytes)} bytes`)
  let at = VERSION_BYTES + 1
  if (data.length < at + REFERENCE_BYTES + BITMAP_BYTES) throw malformed('shorter than its header')
  const entryBytes = data.subarray(at, at + REFERENCE_BYTES)
  const entry = entryBytes.every((byte) => byte === 0) ? undefined : bytesToHex(entryBytes).slice(2)
  at += REFERENCE_BYTES
  const bitmap = data.subarray(at, at + BITMAP_BYTES)
  at += BITMAP_BYTES
  const forks = new Map<number, Fork>()
  for (let byte = 0; byte < 256; byte++) {
    if ((bitmap[byte >> 3]! & (1 << (byte & 7))) === 0) continue
    if (data.length < at + FORK_FIXED_BYTES) throw malformed('a fork cut short')
    const type = data[at]!
    const prefixLength = data[at + 1]!
    if (prefixLength < 1 || prefixLength > PREFIX_FIELD_BYTES) throw malformed(`a fork prefix of ${String(prefixLength)} bytes`)
    const prefix = data.slice(at + 2, at + 2 + prefixLength)
    if (prefix[0] !== byte) throw malformed('a fork filed under another byte than its prefix starts with')
    const reference = bytesToHex(data.subarray(at + 2 + PREFIX_FIELD_BYTES, at + FORK_FIXED_BYTES)).slice(2)
    at += FORK_FIXED_BYTES
    let metadata: Record<string, string> | undefined
    if ((type & TYPE_METADATA) !== 0) {
      if (data.length < at + 2) throw malformed('fork metadata cut short')
      const length = (data[at]! << 8) | data[at + 1]!
      if (length > MAX_METADATA_BYTES || data.length < at + 2 + length) throw malformed('fork metadata cut short')
      metadata = readMetadata(data.subarray(at + 2, at + 2 + length))
      at += 2 + length
    }
    forks.set(byte, { prefix, reference, metadata })
  }
  return { entry, forks }
}

export interface PathEntry {
  /** The file at the path; undefined for a path that only has metadata, or none. Also undefined when the node was not loaded. */
  readonly entry: string | undefined
  /** The metadata of the fork that reached the path's node. */
  readonly metadata: Readonly<Record<string, string>> | undefined
}

export type LoadNode = (reference: string) => Promise<ManifestNode>

/**
 * The node `path` names, or undefined when no fork continues it. Reads at
 * most `maxNodes` nodes; with `readEntry` false the last one is not read, for
 * a caller that wants only the metadata on the way to it. An empty path names
 * the root itself.
 */
export async function lookup (root: string, path: string, load: LoadNode, maxNodes: number, readEntry = true): Promise<PathEntry | undefined> {
  let rest = toBytes(path)
  let node = await load(root)
  let reached: PathEntry = { entry: node.entry, metadata: undefined }
  for (let nodes = 1; rest.length > 0; nodes++) {
    const fork = node.forks.get(rest[0]!)
    if (fork === undefined || fork.prefix.length > rest.length || !fork.prefix.every((byte, i) => byte === rest[i])) return undefined
    if (nodes >= maxNodes) throw new ResolutionError('unverifiable', `more than ${String(maxNodes)} manifest nodes to resolve one path`)
    rest = rest.subarray(fork.prefix.length)
    if (rest.length === 0 && !readEntry) return { entry: undefined, metadata: fork.metadata }
    node = await load(fork.reference)
    reached = { entry: node.entry, metadata: fork.metadata }
  }
  return reached
}
